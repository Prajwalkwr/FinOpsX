import { Prisma, type ReconIssue, type ReconStatus } from '@prisma/client'
import type { Request } from 'express'
import { notFound, unprocessable } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { pageOf } from '../lib/http.js'
import { createWithPublicId } from '../lib/ids.js'
import { num, prisma } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'
import { writeAudit } from './audit.js'

const RECONCILED = Prisma.sql`('SUCCESS', 'SETTLED', 'REVERSED')`

type IssueRow = { transactionRef: string; institutionId: string | null; platformAmount: number | null; institutionAmount: number | null }

/**
 * Compares platform transactions with the simulated institution ledger and with settlement records for a window.
 * Platform side: SUCCESS, SETTLED and REVERSED payments created in the window. Institution side: ledger entries recorded in the window.
 */
export async function runReconciliation(input: { from: Date; to: Date; institutionId?: string; user?: AuthUser | null; jobId?: string; req?: Request }) {
  if (input.to <= input.from) throw unprocessable('The reconciliation window end must be after its start.')
  if (input.to.getTime() - input.from.getTime() > 31 * 86400_000) throw unprocessable('Reconciliation windows are limited to 31 days.')
  const { from, to } = input
  const inst = input.institutionId ? Prisma.sql`AND t."institutionId" = ${input.institutionId}` : Prisma.empty
  const ledgerInst = input.institutionId ? Prisma.sql`AND l."institutionId" = ${input.institutionId}` : Prisma.empty

  const [platform, ledger, missing, mismatched, orphans, unsettled, settled] = await Promise.all([
    prisma.$queryRaw<Array<{ count: number; amount: number; successAmount: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS amount,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('SUCCESS', 'SETTLED')), 0)::float AS "successAmount"
      FROM "Transaction" t WHERE t."createdAt" >= ${from} AND t."createdAt" < ${to} AND t.status IN ${RECONCILED} ${inst}`),
    prisma.$queryRaw<Array<{ count: number; amount: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(l.amount), 0)::float AS amount
      FROM "InstitutionLedgerEntry" l
      LEFT JOIN "Transaction" t ON t.id = l."transactionId"
      WHERE (CASE WHEN t.id IS NULL THEN l."recordedAt" ELSE t."createdAt" END) >= ${from}
        AND (CASE WHEN t.id IS NULL THEN l."recordedAt" ELSE t."createdAt" END) < ${to} ${ledgerInst}`),
    prisma.$queryRaw<IssueRow[]>(Prisma.sql`
      SELECT t."transactionId" AS "transactionRef", t."institutionId", t.amount::float AS "platformAmount", NULL::float AS "institutionAmount"
      FROM "Transaction" t LEFT JOIN "InstitutionLedgerEntry" l ON l."transactionId" = t.id
      WHERE t."createdAt" >= ${from} AND t."createdAt" < ${to} AND t.status IN ${RECONCILED} AND l.id IS NULL ${inst}
      ORDER BY t."createdAt" LIMIT 2000`),
    prisma.$queryRaw<IssueRow[]>(Prisma.sql`
      SELECT t."transactionId" AS "transactionRef", t."institutionId", t.amount::float AS "platformAmount", l.amount::float AS "institutionAmount"
      FROM "Transaction" t JOIN "InstitutionLedgerEntry" l ON l."transactionId" = t.id
      WHERE t."createdAt" >= ${from} AND t."createdAt" < ${to} AND t.status IN ${RECONCILED} AND l.amount <> t.amount ${inst}
      ORDER BY t."createdAt" LIMIT 2000`),
    prisma.$queryRaw<IssueRow[]>(Prisma.sql`
      SELECT l."transactionRef", l."institutionId", NULL::float AS "platformAmount", l.amount::float AS "institutionAmount"
      FROM "InstitutionLedgerEntry" l
      WHERE l."transactionId" IS NULL AND l."recordedAt" >= ${from} AND l."recordedAt" < ${to} ${ledgerInst}
      ORDER BY l."recordedAt" LIMIT 2000`),
    prisma.$queryRaw<IssueRow[]>(Prisma.sql`
      SELECT t."transactionId" AS "transactionRef", t."institutionId", t.amount::float AS "platformAmount", NULL::float AS "institutionAmount"
      FROM "Transaction" t
      WHERE t."createdAt" >= ${from} AND t."createdAt" < ${to} AND t.status = 'SUCCESS' AND t."createdAt" < ${new Date(Date.now() - 3600_000)} ${inst}
      ORDER BY t."createdAt" LIMIT 2000`),
    prisma.$queryRaw<Array<{ count: number; amount: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS amount
      FROM "Transaction" t WHERE t."createdAt" >= ${from} AND t."createdAt" < ${to} AND t.status = 'SETTLED' ${inst}`),
  ])

  const expectedCount = platform[0]?.count ?? 0
  const expectedAmount = platform[0]?.amount ?? 0
  const actualCount = ledger[0]?.count ?? 0
  const actualAmount = ledger[0]?.amount ?? 0
  const unmatched = missing.length + mismatched.length + orphans.length
  const matchedCount = Math.max(0, expectedCount - missing.length - mismatched.length)
  const settledCount = settled[0]?.count ?? 0
  const settledAmount = settled[0]?.amount ?? 0
  const settlementDifference = (platform[0]?.successAmount ?? 0) - settledAmount
  const status: ReconStatus = unmatched === 0 && unsettled.length === 0 ? 'MATCHED' : 'MISMATCH'
  const notes = [
    `${matchedCount} of ${expectedCount} platform records matched the institution ledger.`,
    missing.length ? `${missing.length} missing at institution.` : '',
    mismatched.length ? `${mismatched.length} amount mismatches.` : '',
    orphans.length ? `${orphans.length} institution records with no platform transaction.` : '',
    unsettled.length ? `${unsettled.length} successful payments older than 1 hour are not yet settled.` : '',
  ].filter(Boolean).join(' ')

  const run = await createWithPublicId(
    async () => 5000 + (await prisma.reconciliationRun.count()) + 1,
    (n) => `REC-${n}`,
    (publicId) => prisma.reconciliationRun.create({
      data: {
        publicId,
        windowFrom: from,
        windowTo: to,
        institutionId: input.institutionId,
        status,
        expectedCount,
        actualCount,
        matchedCount,
        unmatchedCount: unmatched,
        expectedAmount,
        actualAmount,
        difference: actualAmount - expectedAmount,
        settledCount,
        settledAmount,
        settlementDifference,
        notes,
        createdById: input.user?.id,
        jobId: input.jobId,
      },
    }),
  )
  const items: Prisma.ReconciliationItemCreateManyInput[] = [
    ...missing.map((row) => ({ ...row, issue: 'MISSING_AT_INSTITUTION' as ReconIssue })),
    ...mismatched.map((row) => ({ ...row, issue: 'AMOUNT_MISMATCH' as ReconIssue })),
    ...orphans.map((row) => ({ ...row, issue: 'MISSING_ON_PLATFORM' as ReconIssue })),
    ...unsettled.map((row) => ({ ...row, issue: 'NOT_SETTLED' as ReconIssue })),
  ].map((row) => ({ runId: run.id, transactionRef: row.transactionRef, institutionId: row.institutionId, issue: row.issue, platformAmount: row.platformAmount, institutionAmount: row.institutionAmount }))
  if (items.length) await prisma.reconciliationItem.createMany({ data: items })
  if (input.user) {
    await writeAudit({ user: input.user, action: 'RAN_RECONCILIATION', resource: 'RECONCILIATION', resourceId: run.publicId, req: input.req, newValue: { from: from.toISOString(), to: to.toISOString(), status, unmatched } })
  }
  emit('reconciliation:completed', { id: run.publicId, status })
  return getRun(run.publicId, { page: 1, limit: 25 })
}

function serializeRun(row: Prisma.ReconciliationRunGetPayload<{ include: { institution: true; createdBy: true } }>) {
  return {
    id: row.publicId,
    windowFrom: row.windowFrom.toISOString(),
    windowTo: row.windowTo.toISOString(),
    institution: row.institution?.name ?? 'All institutions',
    status: row.status,
    expectedCount: row.expectedCount,
    actualCount: row.actualCount,
    matchedCount: row.matchedCount,
    unmatchedCount: row.unmatchedCount,
    expectedAmount: num(row.expectedAmount),
    actualAmount: num(row.actualAmount),
    difference: num(row.difference),
    settledCount: row.settledCount,
    settledAmount: num(row.settledAmount),
    settlementDifference: num(row.settlementDifference),
    matchRate: row.expectedCount ? (row.matchedCount / row.expectedCount) * 100 : 100,
    notes: row.notes,
    createdBy: row.createdBy?.email ?? (row.jobId ? 'Operational job' : 'system'),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listRuns(query: { page: number; limit: number; status?: string }) {
  const where: Prisma.ReconciliationRunWhereInput = query.status ? { status: query.status as ReconStatus } : {}
  const [total, rows] = await prisma.$transaction([
    prisma.reconciliationRun.count({ where }),
    prisma.reconciliationRun.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit, include: { institution: true, createdBy: true } }),
  ])
  return pageOf(rows.map(serializeRun), total, query.page, query.limit)
}

export async function getRun(id: string, query: { page: number; limit: number; issue?: string }) {
  const run = await prisma.reconciliationRun.findFirst({ where: { OR: [{ id }, { publicId: id }] }, include: { institution: true, createdBy: true } })
  if (!run) throw notFound('Reconciliation run not found.')
  const where: Prisma.ReconciliationItemWhereInput = { runId: run.id, ...(query.issue ? { issue: query.issue as ReconIssue } : {}) }
  const [total, items, byIssue, institutions] = await Promise.all([
    prisma.reconciliationItem.count({ where }),
    prisma.reconciliationItem.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
    prisma.reconciliationItem.groupBy({ by: ['issue'], where: { runId: run.id }, _count: { _all: true } }),
    prisma.institution.findMany({ select: { id: true, name: true } }),
  ])
  return {
    ...serializeRun(run),
    issues: byIssue.map((row) => ({ issue: row.issue, count: row._count._all })),
    items: pageOf(items.map((item) => ({
      id: item.id,
      transactionRef: item.transactionRef,
      institution: institutions.find((row) => row.id === item.institutionId)?.name ?? null,
      issue: item.issue,
      platformAmount: item.platformAmount == null ? null : num(item.platformAmount),
      institutionAmount: item.institutionAmount == null ? null : num(item.institutionAmount),
    })), total, query.page, query.limit),
  }
}

export async function updateRun(id: string, input: { status: 'INVESTIGATING' | 'RESOLVED'; notes?: string }, user: AuthUser, req: Request) {
  const run = await prisma.reconciliationRun.findFirst({ where: { OR: [{ id }, { publicId: id }] } })
  if (!run) throw notFound('Reconciliation run not found.')
  if (run.status === 'MATCHED') throw unprocessable('A matched run has nothing to investigate.')
  await prisma.reconciliationRun.update({ where: { id: run.id }, data: { status: input.status, notes: input.notes ? `${run.notes ?? ''}\n${user.email}: ${input.notes}`.trim() : run.notes } })
  await writeAudit({ user, action: 'UPDATED_RECONCILIATION', resource: 'RECONCILIATION', resourceId: run.publicId, req, previousValue: { status: run.status }, newValue: { status: input.status, notes: input.notes ?? null } })
  return getRun(run.publicId, { page: 1, limit: 25 })
}

export async function reconciliationSummary() {
  const latest = await prisma.reconciliationRun.findFirst({ orderBy: { createdAt: 'desc' }, include: { institution: true, createdBy: true } })
  const open = await prisma.reconciliationRun.count({ where: { status: { in: ['MISMATCH', 'INVESTIGATING'] } } })
  return { latest: latest ? serializeRun(latest) : null, openRuns: open }
}
