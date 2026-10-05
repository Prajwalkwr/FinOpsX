import { Prisma, type JobStatus, type JobType } from '@prisma/client'
import { JOB_LABEL } from '@finopsx/shared'
import type { Request } from 'express'
import { conflict, notFound } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { pageOf } from '../lib/http.js'
import { createWithPublicId } from '../lib/ids.js'
import { logger } from '../lib/logger.js'
import { prisma } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'
import { kathmanduNow, resolveRange } from '../utils/range.js'
import { writeAudit } from './audit.js'
import { runDataQualityScan } from './dataQualityService.js'
import { notifyUsers } from './notify.js'
import { runReconciliation } from './reconciliationService.js'
import { generateReport } from './reportService.js'
import { runSettlementCycle, validateSettlements } from './settlementService.js'

export const JOB_DESCRIPTIONS: Record<JobType, { cadence: 'EOD' | 'BOD'; description: string }> = {
  EOD_SETTLEMENT: { cadence: 'EOD', description: 'Settles every queued successful payment and re-submits delayed batches.' },
  TRANSACTION_RECONCILIATION: { cadence: 'EOD', description: 'Compares platform records with the institution ledger and settlement records.' },
  DAILY_REPORT: { cadence: 'EOD', description: 'Generates the Daily Operations report for the selected day.' },
  DATA_VALIDATION: { cadence: 'BOD', description: 'Runs all data quality checks and refreshes the issue list.' },
  BACKUP_SIMULATION: { cadence: 'BOD', description: 'Simulates a nightly backup by snapshotting table row counts and database size. No data is copied.' },
  SETTLEMENT_VALIDATION: { cadence: 'BOD', description: 'Confirms each settlement batch total equals the sum of its transactions.' },
}

type JobResult = { processed: number; successful: number; failed: number; output: Record<string, unknown> }
type JobOptions = { range?: 'today' | 'yesterday' }

async function execute(type: JobType, jobId: string, options: JobOptions): Promise<JobResult> {
  switch (type) {
    case 'EOD_SETTLEMENT': {
      const result = await runSettlementCycle({ source: 'eod', minAgeMs: 0, jobId })
      return { processed: result.settledTransactions + result.delayedTransactions, successful: result.settledTransactions, failed: result.delayedTransactions, output: result }
    }
    case 'TRANSACTION_RECONCILIATION': {
      const range = resolveRange({ range: options.range ?? 'yesterday' })
      const run = await runReconciliation({ from: range.from, to: range.to, jobId })
      return { processed: run.expectedCount, successful: run.matchedCount, failed: run.unmatchedCount, output: { reconciliationId: run.id, status: run.status, window: range.label, difference: run.difference, settlementDifference: run.settlementDifference } }
    }
    case 'DAILY_REPORT': {
      const range = resolveRange({ range: options.range ?? 'yesterday' })
      const report = await generateReport({ type: 'DAILY_OPERATIONS', from: range.from.toISOString(), to: range.to.toISOString(), source: 'job' })
      return { processed: 1, successful: 1, failed: 0, output: { reportId: report.id, title: report.title } }
    }
    case 'DATA_VALIDATION': {
      const result = await runDataQualityScan()
      return { processed: result.total, successful: Math.max(0, result.total - result.failed), failed: result.failed, output: { byType: result.byType } }
    }
    case 'BACKUP_SIMULATION': {
      const tables = ['Transaction', 'TransactionEvent', 'InstitutionLedgerEntry', 'Settlement', 'Incident', 'Anomaly', 'AuditLog', 'Report']
      const counts = await prisma.$queryRaw<Array<{ table: string; rows: number }>>(Prisma.sql`
        ${Prisma.join(tables.map((table) => Prisma.sql`SELECT ${table} AS table, COUNT(*)::int AS rows FROM ${Prisma.raw(`"${table}"`)}`), ' UNION ALL ')}`)
      const [size] = await prisma.$queryRaw<Array<{ bytes: bigint }>>`SELECT pg_database_size(current_database()) AS bytes`
      const rows = counts.reduce((sum, row) => sum + row.rows, 0)
      const stamp = kathmanduNow().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      return {
        processed: rows,
        successful: rows,
        failed: 0,
        output: { simulated: true, snapshot: `finopsx-demo-${stamp}.dump`, sizeMb: Number((Number(size?.bytes ?? 0) / 1024 / 1024).toFixed(1)), tables: counts, note: 'Simulation only — row counts and size are measured, but no backup file is written.' },
      }
    }
    case 'SETTLEMENT_VALIDATION': {
      const result = await validateSettlements(7)
      return { processed: result.processed, successful: result.successful, failed: result.failed, output: result }
    }
  }
}

function serialize(row: Prisma.OperationalJobGetPayload<object>) {
  return {
    id: row.publicId,
    type: row.type,
    label: JOB_LABEL[row.type],
    cadence: JOB_DESCRIPTIONS[row.type].cadence,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    recordsProcessed: row.recordsProcessed,
    successfulRecords: row.successfulRecords,
    failedRecords: row.failedRecords,
    triggeredBy: row.triggeredBy,
    output: row.output,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  }
}

async function runJobWork(jobId: string, type: JobType, options: JobOptions) {
  const startedAt = new Date()
  await prisma.operationalJob.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt } })
  emit('job:updated', { id: jobId, type, status: 'RUNNING' })
  try {
    const result = await execute(type, jobId, options)
    const finishedAt = new Date()
    await prisma.operationalJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), recordsProcessed: result.processed, successfulRecords: result.successful, failedRecords: result.failed, output: result.output as Prisma.InputJsonValue },
    })
    emit('job:updated', { id: jobId, type, status: 'COMPLETED' })
  } catch (error) {
    const finishedAt = new Date()
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown error'
    logger.error('operational job failed', { type, error: message })
    await prisma.operationalJob.update({ where: { id: jobId }, data: { status: 'FAILED', finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), error: message } })
    await notifyUsers({ roles: ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ENGINEER'], type: 'JOB_FAILED', title: `${JOB_LABEL[type]} failed`, message, severity: 'HIGH', link: '/jobs' })
    emit('job:updated', { id: jobId, type, status: 'FAILED' })
  }
}

/** Queues a job and runs it in the background. Only one job of each type can be queued or running at a time. */
export async function triggerJob(type: JobType, options: JobOptions & { triggeredBy: string; user?: AuthUser; req?: Request; wait?: boolean }) {
  await prisma.operationalJob.updateMany({ where: { type, status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lt: new Date(Date.now() - 15 * 60_000) } }, data: { status: 'FAILED', error: 'Marked failed: job did not finish within 15 minutes.', finishedAt: new Date() } })
  const active = await prisma.operationalJob.findFirst({ where: { type, status: { in: ['QUEUED', 'RUNNING'] } } })
  if (active) throw conflict(`${JOB_LABEL[type]} is already ${active.status.toLowerCase()} (${active.publicId}).`)
  const job = await createWithPublicId(
    async () => 7000 + (await prisma.operationalJob.count()) + 1,
    (n) => `JOB-${n}`,
    (publicId) => prisma.operationalJob.create({ data: { publicId, type, status: 'QUEUED', triggeredBy: options.triggeredBy, output: options.range ? { range: options.range } : undefined } }),
  )
  if (options.user) {
    await writeAudit({ user: options.user, action: 'TRIGGERED_JOB', resource: 'OPERATIONAL_JOB', resourceId: job.publicId, req: options.req, newValue: { type, range: options.range ?? null } })
  }
  emit('job:updated', { id: job.publicId, type, status: 'QUEUED' })
  const work = runJobWork(job.id, type, options)
  if (options.wait) await work
  else void work
  const latest = await prisma.operationalJob.findUniqueOrThrow({ where: { id: job.id } })
  return serialize(latest)
}

export async function listJobs(query: { page: number; limit: number; type?: string; status?: string }) {
  const where: Prisma.OperationalJobWhereInput = {
    ...(query.type ? { type: query.type as JobType } : {}),
    ...(query.status ? { status: query.status as JobStatus } : {}),
  }
  const [total, rows] = await prisma.$transaction([
    prisma.operationalJob.count({ where }),
    prisma.operationalJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
  ])
  return pageOf(rows.map(serialize), total, query.page, query.limit)
}

export async function jobCatalog() {
  const latest = await Promise.all(
    (Object.keys(JOB_DESCRIPTIONS) as JobType[]).map(async (type) => {
      const last = await prisma.operationalJob.findFirst({ where: { type }, orderBy: { createdAt: 'desc' } })
      return { type, label: JOB_LABEL[type], ...JOB_DESCRIPTIONS[type], lastRun: last ? serialize(last) : null }
    }),
  )
  return latest
}

export async function getJob(id: string) {
  const row = await prisma.operationalJob.findFirst({ where: { OR: [{ id }, { publicId: id }] } })
  if (!row) throw notFound('Job not found.')
  return serialize(row)
}

const EOD: JobType[] = ['EOD_SETTLEMENT', 'TRANSACTION_RECONCILIATION', 'DAILY_REPORT']
const BOD: JobType[] = ['DATA_VALIDATION', 'SETTLEMENT_VALIDATION', 'BACKUP_SIMULATION']

/** EOD jobs run after 00:05 and BOD jobs after 06:00 Kathmandu time, once per local day. */
export async function runDueScheduledJobs() {
  const local = kathmanduNow()
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
  const dayStart = resolveRange({ range: 'today' }).from
  const due = [...(minutes >= 5 ? EOD : []), ...(minutes >= 360 ? BOD : [])]
  for (const type of due) {
    const done = await prisma.operationalJob.findFirst({ where: { type, triggeredBy: 'schedule', createdAt: { gte: dayStart } } })
    if (done) continue
    await triggerJob(type, { triggeredBy: 'schedule', wait: true }).catch((error) => logger.warn('scheduled job skipped', { type, error: error instanceof Error ? error.message : 'unknown' }))
  }
}

let timer: NodeJS.Timeout | null = null
export function startJobScheduler() {
  if (timer) return
  timer = setInterval(() => { runDueScheduledJobs().catch(() => undefined) }, 5 * 60_000)
}

export function stopJobScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}
