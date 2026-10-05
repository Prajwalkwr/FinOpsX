import { Prisma } from '@prisma/client'
import { logger } from '../lib/logger.js'
import { prisma } from '../lib/prisma.js'
import { connectedClients, emit } from '../lib/realtime.js'
import { ACTIVE_STATUSES } from './incidentService.js'

/** Short-window live figures pushed to connected dashboards. Same definitions as the canonical aggregates. */
export async function liveSnapshot() {
  const now = Date.now()
  const minuteAgo = new Date(now - 60_000)
  const fiveAgo = new Date(now - 5 * 60_000)
  const [tx, last5, api, incidents, anomalies, services, pending] = await Promise.all([
    prisma.transaction.count({ where: { createdAt: { gte: minuteAgo } } }),
    prisma.$queryRaw<Array<{ total: number; failed: number; success: number; latency: number | null; value: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE status IN ('SUCCESS', 'SETTLED'))::int AS success, AVG("responseTimeMs")::float AS latency, COALESCE(SUM(amount), 0)::float AS value
      FROM "Transaction" WHERE "createdAt" >= ${fiveAgo}`),
    prisma.$queryRaw<Array<{ total: number; ok: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE "statusCode" < 500)::int AS ok FROM "ApiCall" WHERE "createdAt" >= ${fiveAgo}`),
    prisma.incident.count({ where: { status: { in: ACTIVE_STATUSES } } }),
    prisma.anomaly.count({ where: { status: { in: ['DETECTED', 'REVIEW'] } } }),
    prisma.service.findMany({ select: { key: true, name: true, status: true } }),
    prisma.transaction.count({ where: { status: 'PENDING' } }),
  ])
  const window = last5[0] ?? { total: 0, failed: 0, success: 0, latency: null, value: 0 }
  const overall = services.some((row) => row.status === 'INCIDENT') ? 'Incident' : services.some((row) => row.status === 'DEGRADED') ? 'Degraded' : 'All Systems Operational'
  return {
    at: new Date(now).toISOString(),
    transactionsLastMinute: tx,
    window5m: {
      total: window.total,
      successRate: window.total ? (window.success / window.total) * 100 : null,
      failureRate: window.total ? (window.failed / window.total) * 100 : null,
      avgLatencyMs: window.latency,
      value: window.value,
      apiAvailability: api[0]?.total ? (api[0].ok / api[0].total) * 100 : null,
    },
    activeIncidents: incidents,
    openAnomalies: anomalies,
    pendingTransactions: pending,
    systemStatus: overall,
    degradedServices: services.filter((row) => row.status !== 'OPERATIONAL').map((row) => ({ key: row.key, name: row.name, status: row.status })),
  }
}

let timer: NodeJS.Timeout | null = null
let busy = false

export function startLiveMetrics() {
  if (timer) return
  timer = setInterval(() => {
    if (busy || connectedClients() === 0) return
    busy = true
    liveSnapshot()
      .then((snapshot) => emit('metrics:tick', snapshot))
      .catch((error) => logger.warn('live metrics failed', { error: error instanceof Error ? error.message : 'unknown' }))
      .finally(() => { busy = false })
  }, 5000)
}

export function stopLiveMetrics() {
  if (timer) clearInterval(timer)
  timer = null
}
