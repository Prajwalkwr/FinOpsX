import os from 'os'
import { monitorEventLoopDelay } from 'perf_hooks'
import { Prisma, type ServiceStatus } from '@prisma/client'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { prisma } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'
import { redisState } from '../lib/redis.js'
import { refreshEndpointRegistry } from './apiObservability.js'
import { ACTIVE_STATUSES } from './incidentService.js'
import { healthScore } from './metricsService.js'
import { getThresholds } from './thresholds.js'

const loopDelay = monitorEventLoopDelay({ resolution: 20 })
loopDelay.enable()
let lastCpu = process.cpuUsage()
let lastCpuAt = Date.now()

export type Telemetry = 'api-calls' | 'transactions' | 'measured' | 'none'

const TELEMETRY: Record<string, Telemetry> = {
  'payment-gateway': 'api-calls',
  'auth-service': 'api-calls',
  'payment-api': 'api-calls',
  'settlement-service': 'api-calls',
  'bank-api': 'api-calls',
  'notification-service': 'api-calls',
  'wallet-service': 'transactions',
  'transaction-db': 'measured',
  redis: 'measured',
  'ai-service': 'measured',
  'merchant-api': 'none',
}

const rankStatus = (status: ServiceStatus) => ['OPERATIONAL', 'MAINTENANCE', 'DEGRADED', 'INCIDENT'].indexOf(status)
const worst = (a: ServiceStatus, b: ServiceStatus) => (rankStatus(b) > rankStatus(a) ? b : a)

/** Recomputes service and institution status from the last two minutes of stored telemetry plus active incidents. */
export async function refreshServiceMetrics() {
  const thresholds = await getThresholds()
  const now = Date.now()
  const recent = new Date(now - 2 * 60_000)
  const hour = new Date(now - 60 * 60_000)
  await refreshEndpointRegistry()
  const [services, perService, perServiceHour, incidents, wallet, aiLatency] = await Promise.all([
    prisma.service.findMany(),
    prisma.$queryRaw<Array<{ serviceId: string; total: number; errors: number; avg: number; p95: number }>>(Prisma.sql`
      SELECT e."serviceId", COUNT(c.id)::int AS total, COUNT(c.id) FILTER (WHERE c."statusCode" >= 500)::int AS errors,
        AVG(c."latencyMs")::float AS avg, percentile_cont(0.95) WITHIN GROUP (ORDER BY c."latencyMs")::float AS p95
      FROM "ApiCall" c JOIN "ApiMetric" e ON e.id = c."endpointId" WHERE c."createdAt" >= ${recent} GROUP BY e."serviceId"`),
    prisma.$queryRaw<Array<{ serviceId: string; total: number; errors: number }>>(Prisma.sql`
      SELECT e."serviceId", COUNT(c.id)::int AS total, COUNT(c.id) FILTER (WHERE c."statusCode" >= 500)::int AS errors
      FROM "ApiCall" c JOIN "ApiMetric" e ON e.id = c."endpointId" WHERE c."createdAt" >= ${hour} GROUP BY e."serviceId"`),
    prisma.incident.findMany({ where: { status: { in: ACTIVE_STATUSES } }, include: { services: true, institutions: true } }),
    prisma.$queryRaw<Array<{ total: number; failed: number; avg: number }>>(Prisma.sql`
      SELECT COUNT(t.id)::int AS total, COUNT(t.id) FILTER (WHERE t.status = 'FAILED')::int AS failed, COALESCE(AVG(t."responseTimeMs"), 0)::float AS avg
      FROM "Transaction" t JOIN "Institution" i ON i.id = t."institutionId" WHERE i.code = 'DWL' AND t."createdAt" >= ${recent}`),
    prisma.aiQuery.aggregate({ where: { createdAt: { gte: hour } }, _avg: { durationMs: true }, _count: { _all: true } }),
  ])
  const dbStart = performance.now()
  let dbOk = true
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    dbOk = false
  }
  const dbLatency = Math.max(1, Math.round(performance.now() - dbStart))
  const changes: Array<{ key: string; from: ServiceStatus; to: ServiceStatus }> = []

  for (const service of services) {
    const telemetry = TELEMETRY[service.key] ?? 'none'
    let status: ServiceStatus = 'OPERATIONAL'
    let responseTimeMs = service.responseTimeMs
    let errorRate = 0
    let uptime = service.uptime
    if (telemetry === 'api-calls') {
      const row = perService.find((item) => item.serviceId === service.id)
      const hourRow = perServiceHour.find((item) => item.serviceId === service.id)
      if (row && row.total > 0) {
        responseTimeMs = Math.round(row.avg)
        errorRate = (row.errors / row.total) * 100
        const availability = 100 - errorRate
        if (row.total >= 10 && (availability < thresholds.availabilityPct - 20)) status = 'INCIDENT'
        else if (row.total >= 10 && (availability < thresholds.availabilityPct || row.p95 > thresholds.latencyMs || errorRate >= 5)) status = 'DEGRADED'
      }
      if (hourRow && hourRow.total > 0) uptime = ((hourRow.total - hourRow.errors) / hourRow.total) * 100
    } else if (telemetry === 'transactions') {
      const row = wallet[0]
      if (row && row.total > 0) {
        responseTimeMs = Math.round(row.avg)
        errorRate = (row.failed / row.total) * 100
        if (row.total >= 5 && (row.avg > thresholds.latencyMs || errorRate >= Math.max(10, thresholds.failureRatePct * 2))) status = 'DEGRADED'
      }
    } else if (service.key === 'transaction-db') {
      responseTimeMs = dbLatency
      status = dbOk ? (dbLatency > 500 ? 'DEGRADED' : 'OPERATIONAL') : 'INCIDENT'
      uptime = dbOk ? 100 : 0
    } else if (service.key === 'redis') {
      const state = redisState()
      status = state === 'DOWN' ? 'DEGRADED' : 'OPERATIONAL'
      responseTimeMs = 0
    } else if (service.key === 'ai-service') {
      responseTimeMs = Math.round(aiLatency._avg.durationMs ?? 0)
    }
    for (const incident of incidents) {
      if (!incident.services.some((link) => link.serviceId === service.id)) continue
      status = worst(status, incident.severity === 'HIGH' || incident.severity === 'CRITICAL' ? 'INCIDENT' : 'DEGRADED')
    }
    if (status !== service.status) changes.push({ key: service.key, from: service.status, to: status })
    await prisma.service.update({
      where: { id: service.id },
      data: { status, responseTimeMs, errorRate: Number(errorRate.toFixed(2)), uptime: Number(uptime.toFixed(3)), lastCheckedAt: new Date() },
    })
  }

  const institutions = await prisma.$queryRaw<Array<{ id: string; status: ServiceStatus; total: number; failed: number; avg: number }>>(Prisma.sql`
    SELECT i.id, i.status, COUNT(t.id)::int AS total, COUNT(t.id) FILTER (WHERE t.status = 'FAILED')::int AS failed, COALESCE(AVG(t."responseTimeMs"), 0)::float AS avg
    FROM "Institution" i LEFT JOIN "Transaction" t ON t."institutionId" = i.id AND t."createdAt" >= ${recent} GROUP BY i.id`)
  for (const institution of institutions) {
    let status: ServiceStatus = 'OPERATIONAL'
    if (institution.total >= 5) {
      const failure = (institution.failed / institution.total) * 100
      if (institution.avg >= thresholds.latencyMs * 0.8 || failure >= Math.max(10, thresholds.failureRatePct * 2)) status = 'DEGRADED'
    }
    for (const incident of incidents) {
      if (!incident.institutions.some((link) => link.institutionId === institution.id)) continue
      status = worst(status, incident.severity === 'HIGH' || incident.severity === 'CRITICAL' ? 'INCIDENT' : 'DEGRADED')
    }
    if (status !== institution.status) await prisma.institution.update({ where: { id: institution.id }, data: { status } })
  }

  if (changes.length) {
    const latest = await prisma.service.findMany({ orderBy: { name: 'asc' } })
    emit('system:status', {
      changes,
      services: latest.map((service) => ({ key: service.key, name: service.name, status: service.status, responseTimeMs: service.responseTimeMs, uptime: service.uptime })),
    })
    for (const change of changes) {
      if (change.to === 'OPERATIONAL') emit('service:recovered', { key: change.key })
      else emit('service:degraded', { key: change.key, status: change.to })
    }
  }
  return changes
}

/** Records one infrastructure sample. Process, database and Redis values are measured; replication lag, slow queries and cache usage are simulated. */
export async function recordInfrastructure() {
  const elapsed = (Date.now() - lastCpuAt) * 1000
  const usage = process.cpuUsage(lastCpu)
  lastCpu = process.cpuUsage()
  lastCpuAt = Date.now()
  const cpu = elapsed > 0 ? Math.min(100, ((usage.user + usage.system) / elapsed) * 100) : 0
  const memory = ((os.totalmem() - os.freemem()) / os.totalmem()) * 100
  const [connections, size, queue] = await Promise.all([
    prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()`,
    prisma.$queryRaw<Array<{ bytes: bigint }>>`SELECT pg_database_size(current_database()) AS bytes`,
    prisma.transaction.count({ where: { status: 'PENDING' } }),
  ])
  const lagMs = loopDelay.mean / 1e6
  loopDelay.reset()
  const range = { from: new Date(Date.now() - 60 * 60_000), to: new Date() }
  const score = await healthScore({ ...range, unit: 'minute', label: 'Last hour' })
  const row = await prisma.systemMetric.create({
    data: {
      cpu: Number(cpu.toFixed(2)),
      memory: Number(memory.toFixed(2)),
      dbConnections: connections[0]?.count ?? 0,
      redisUp: redisState() === 'UP',
      queueLength: queue,
      healthScore: score.score,
      storageMb: Number((Number(size[0]?.bytes ?? 0) / 1024 / 1024).toFixed(1)),
      slowQueries: Math.random() < 0.15 ? 1 : 0,
      replicationLagMs: Math.round(20 + Math.random() * 60),
      cacheUsagePct: Number((30 + Math.random() * 15).toFixed(1)),
      processMemoryMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
      eventLoopLagMs: Number((Number.isFinite(lagMs) ? lagMs : 0).toFixed(2)),
      simulated: false,
    },
  })
  emit('infrastructure:sample', { recordedAt: row.recordedAt.toISOString() })
  return row
}

export const INFRA_METRICS = [
  { key: 'cpu', label: 'API process CPU', unit: '%', measured: true, note: 'process.cpuUsage() of the API server' },
  { key: 'memory', label: 'Host memory used', unit: '%', measured: true, note: 'os.totalmem() / os.freemem()' },
  { key: 'processMemoryMb', label: 'API process memory (RSS)', unit: 'MB', measured: true, note: 'process.memoryUsage().rss' },
  { key: 'eventLoopLagMs', label: 'Event loop lag', unit: 'ms', measured: true, note: 'perf_hooks.monitorEventLoopDelay' },
  { key: 'dbConnections', label: 'Database connections', unit: '', measured: true, note: 'pg_stat_activity for this database' },
  { key: 'storageMb', label: 'Database storage', unit: 'MB', measured: true, note: 'pg_database_size()' },
  { key: 'queueLength', label: 'Pending payment queue', unit: '', measured: true, note: 'Transactions currently PENDING' },
  { key: 'slowQueries', label: 'Slow queries', unit: '', measured: false, note: 'Simulated — pg_stat_statements is not enabled' },
  { key: 'replicationLagMs', label: 'Replication lag', unit: 'ms', measured: false, note: 'Simulated — single-node demo database' },
  { key: 'cacheUsagePct', label: 'Cache usage', unit: '%', measured: false, note: 'Simulated — Redis is optional in this demo' },
] as const

export async function infrastructure(hours = 6) {
  const since = new Date(Date.now() - hours * 3600_000)
  const [latest, history] = await Promise.all([
    prisma.systemMetric.findFirst({ orderBy: { recordedAt: 'desc' } }),
    prisma.systemMetric.findMany({ where: { recordedAt: { gte: since } }, orderBy: { recordedAt: 'asc' }, take: 720 }),
  ])
  return {
    label: 'Demo Infrastructure Metrics',
    note: 'Measured values come from the running demo API process and its Postgres database. Values marked simulated are generated for demonstration.',
    redis: redisState(),
    metrics: INFRA_METRICS.map((metric) => ({ ...metric, value: latest ? Number(latest[metric.key]) : null })),
    healthScore: latest?.healthScore ?? null,
    recordedAt: latest?.recordedAt.toISOString() ?? null,
    history: history.map((row) => ({
      time: row.recordedAt.toISOString(),
      cpu: row.cpu,
      memory: row.memory,
      processMemoryMb: row.processMemoryMb,
      eventLoopLagMs: row.eventLoopLagMs,
      dbConnections: row.dbConnections,
      queueLength: row.queueLength,
      healthScore: row.healthScore,
    })),
  }
}

export async function systemHealth() {
  const [services, infra] = await Promise.all([
    prisma.service.findMany({ orderBy: [{ layer: 'asc' }, { name: 'asc' }], include: { _count: { select: { apiEndpoints: true } } } }),
    infrastructure(1),
  ])
  return {
    simulatedInfrastructure: true,
    services: services.map((service) => {
      const telemetry = TELEMETRY[service.key] ?? 'none'
      return {
        id: service.id,
        key: service.key,
        name: service.name,
        layer: service.layer,
        description: service.description,
        status: service.status,
        telemetry,
        responseTimeMs: telemetry === 'none' || (service.key === 'redis') ? null : service.responseTimeMs,
        errorRate: telemetry === 'api-calls' || telemetry === 'transactions' ? service.errorRate : null,
        uptime: telemetry === 'api-calls' || service.key === 'transaction-db' ? service.uptime : null,
        endpoints: service._count.apiEndpoints,
        lastCheckedAt: service.lastCheckedAt.toISOString(),
      }
    }),
    infrastructure: infra,
  }
}

/** Keeps the demo database bounded: per-call API rows, metric samples and AI query logs are pruned. */
export async function housekeeping() {
  const now = Date.now()
  const [calls, metrics, queries] = await Promise.all([
    prisma.apiCall.deleteMany({ where: { createdAt: { lt: new Date(now - 6 * 3600_000) } } }),
    prisma.systemMetric.deleteMany({ where: { recordedAt: { lt: new Date(now - 7 * 86400_000) } } }),
    prisma.aiQuery.deleteMany({ where: { createdAt: { lt: new Date(now - 30 * 86400_000) } } }),
  ])
  const transactions = await pruneTransactions(now)
  return { apiCalls: calls.count, systemMetrics: metrics.count, aiQueries: queries.count, transactions }
}

/** Keeps the continuously simulated dataset bounded: age-based retention plus a hard row cap, deleted in small batches. */
async function pruneTransactions(now: number) {
  let cutoff = new Date(now - env.transactionRetentionDays * 86400_000)
  const total = await prisma.transaction.count()
  if (total > env.maxTransactions) {
    const boundary = await prisma.transaction.findFirst({ orderBy: { createdAt: 'desc' }, skip: env.maxTransactions, select: { createdAt: true } })
    if (boundary && boundary.createdAt > cutoff) cutoff = boundary.createdAt
  }
  let deleted = 0
  for (let i = 0; i < 50; i += 1) {
    const batch = await prisma.transaction.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take: 2000 })
    if (!batch.length) break
    const result = await prisma.transaction.deleteMany({ where: { id: { in: batch.map((row) => row.id) } } })
    deleted += result.count
  }
  await prisma.institutionLedgerEntry.deleteMany({ where: { recordedAt: { lt: cutoff } } })
  await prisma.settlement.deleteMany({ where: { createdAt: { lt: cutoff }, transactions: { none: {} } } })
  if (deleted) logger.info('Pruned old synthetic transactions', { deleted, before: cutoff.toISOString() })
  return deleted
}

let timer: NodeJS.Timeout | null = null
let infraTimer: NodeJS.Timeout | null = null
let houseTimer: NodeJS.Timeout | null = null
let refreshing = false

export function startHealthLoop() {
  if (timer) return
  const refresh = () => {
    if (refreshing) return
    refreshing = true
    refreshServiceMetrics()
      .catch((error) => logger.error('health refresh failed', { error: error instanceof Error ? error.message : 'unknown' }))
      .finally(() => { refreshing = false })
  }
  timer = setInterval(refresh, 10_000)
  infraTimer = setInterval(() => { recordInfrastructure().catch(() => undefined) }, 60_000)
  houseTimer = setInterval(() => { housekeeping().catch(() => undefined) }, 15 * 60_000)
  refresh()
  recordInfrastructure().catch(() => undefined)
}

export function stopHealthLoop() {
  if (timer) clearInterval(timer)
  if (infraTimer) clearInterval(infraTimer)
  if (houseTimer) clearInterval(houseTimer)
  timer = null
  infraTimer = null
  houseTimer = null
}
