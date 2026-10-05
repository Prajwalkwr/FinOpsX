import { Prisma } from '@prisma/client'
import { logger } from '../lib/logger.js'
import { prisma } from '../lib/prisma.js'
import { formatMs } from './anomalyService.js'
import { raiseIncident } from './incidentService.js'
import { getThresholds } from './thresholds.js'

const streaks = new Map<string, number>()
let windowFloor = 0

function streak(key: string, hit: boolean) {
  const next = hit ? (streaks.get(key) ?? 0) + 1 : 0
  streaks.set(key, next)
  return next
}

export function resetRuleState() {
  streaks.clear()
}

/** After a scenario ends, rolling windows must not re-read the degraded samples, or a stale incident opens with no scenario attached. */
export function markRecovery() {
  streaks.clear()
  windowFloor = Date.now()
}

function since(ms: number, now: number) {
  return new Date(Math.max(now - ms, windowFloor))
}

async function serviceIds(keys: string[]) {
  const rows = await prisma.service.findMany({ where: { key: { in: keys } }, select: { id: true } })
  return rows.map((row) => row.id)
}

/**
 * Incident rules evaluated every few seconds against stored transactions and API calls.
 * Each rule needs a volume gate and, for latency, consecutive breaches before opening an incident.
 */
export async function evaluateIncidentRules() {
  const thresholds = await getThresholds()
  const config = await prisma.simulatorConfig.findUnique({ where: { id: 'default' } })
  const scenario = config?.scenario ?? null
  const now = Date.now()
  const windowStart = since(60_000, now)
  const raised: string[] = []
  const open = async (input: Parameters<typeof raiseIncident>[0]) => {
    const result = await raiseIncident({ ...input, scenario })
    if (result.created) raised.push(result.incident.publicId)
  }

  const [perInstitution, baseline] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string; name: string; code: string; total: number; failed: number; latency: number }>>(Prisma.sql`
      SELECT i.id, i.name, i.code, COUNT(t.id)::int AS total, COUNT(t.id) FILTER (WHERE t.status = 'FAILED')::int AS failed, COALESCE(AVG(t."responseTimeMs"), 0)::float AS latency
      FROM "Institution" i LEFT JOIN "Transaction" t ON t."institutionId" = i.id AND t."createdAt" >= ${windowStart}
      GROUP BY i.id`),
    prisma.$queryRaw<Array<{ total: number; failed: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
      FROM "Transaction" WHERE "createdAt" >= ${new Date(now - 24 * 3600_000)} AND "createdAt" < ${new Date(now - 5 * 60_000)}`),
  ])
  const baselineFailure = baseline[0]?.total ? (baseline[0].failed / baseline[0].total) * 100 : 4
  const failureTrigger = Math.max(thresholds.failureRatePct, baselineFailure * 2.5)

  for (const institution of perInstitution) {
    const latencyHit = institution.total >= 5 && institution.latency >= thresholds.latencyMs
    if (streak(`latency:${institution.id}`, latencyHit) === thresholds.consecutiveLatencyChecks) {
      const serviceKey = institution.code === 'DWL' ? 'wallet-service' : 'bank-api'
      await open({
        title: `${institution.name} API latency above ${formatMs(thresholds.latencyMs)}`,
        description: `${institution.name} average response time was ${formatMs(institution.latency)} over the last minute for ${thresholds.consecutiveLatencyChecks} consecutive checks (threshold ${formatMs(thresholds.latencyMs)}). ${institution.failed} of ${institution.total} payments failed.`,
        severity: institution.latency >= thresholds.latencyMs * 1.4 ? 'HIGH' : 'MEDIUM',
        incidentType: 'LATENCY',
        serviceIds: await serviceIds([serviceKey]),
        institutionIds: [institution.id],
        affectedTransactionCount: institution.failed,
      })
    }
  }

  const totals = perInstitution.reduce((acc, row) => ({ total: acc.total + row.total, failed: acc.failed + row.failed }), { total: 0, failed: 0 })
  const platformFailure = totals.total ? (totals.failed / totals.total) * 100 : 0
  const gate = Math.max(10, Math.round(thresholds.rpmGate / 2))
  if (streak('failure:platform', totals.total >= gate && platformFailure >= failureTrigger) === 2) {
    const affected = perInstitution.filter((row) => row.total >= 5 && (row.failed / row.total) * 100 >= failureTrigger)
    await open({
      title: 'Payment failure rate spike',
      description: `Platform failure rate reached ${platformFailure.toFixed(1)}% over the last minute (${totals.failed} of ${totals.total} payments) against a 24-hour baseline of ${baselineFailure.toFixed(1)}%.`,
      severity: platformFailure >= failureTrigger * 2 ? 'CRITICAL' : 'HIGH',
      incidentType: 'FAILURE_SPIKE',
      serviceIds: await serviceIds(['payment-api']),
      institutionIds: affected.map((row) => row.id),
      affectedTransactionCount: totals.failed,
    })
  }

  const endpoints = await prisma.$queryRaw<Array<{ id: string; key: string; serviceId: string; serviceName: string; total: number; errors: number }>>(Prisma.sql`
    SELECT e.id, e.method || ' ' || e.endpoint AS key, e."serviceId", s.name AS "serviceName", COUNT(c.id)::int AS total, COUNT(c.id) FILTER (WHERE c."statusCode" >= 500)::int AS errors
    FROM "ApiMetric" e JOIN "Service" s ON s.id = e."serviceId" JOIN "ApiCall" c ON c."endpointId" = e.id AND c."createdAt" >= ${since(120_000, now)}
    GROUP BY e.id, s.name`)
  for (const endpoint of endpoints) {
    const availability = endpoint.total ? ((endpoint.total - endpoint.errors) / endpoint.total) * 100 : 100
    if (streak(`availability:${endpoint.id}`, endpoint.total >= 20 && availability < thresholds.availabilityPct) === 2) {
      const notification = endpoint.key === 'POST /notify'
      await open({
        title: `${endpoint.serviceName} availability below ${thresholds.availabilityPct}%`,
        description: `${endpoint.key} availability was ${availability.toFixed(1)}% over the last 2 minutes (${endpoint.errors} of ${endpoint.total} calls returned 5xx).`,
        severity: availability < thresholds.availabilityPct - 20 ? 'HIGH' : 'MEDIUM',
        incidentType: notification ? 'NOTIFICATION' : 'AVAILABILITY',
        serviceIds: [endpoint.serviceId],
      })
    }
  }

  const delayed = await prisma.transaction.count({ where: { settlementStatus: 'DELAYED', updatedAt: { gte: since(10 * 60_000, now) } } })
  if (streak('settlement', delayed >= 10) === 1) {
    const delayedValue = await prisma.transaction.aggregate({ where: { settlementStatus: 'DELAYED', updatedAt: { gte: since(10 * 60_000, now) } }, _sum: { amount: true } })
    await open({
      title: 'Settlement batches delayed',
      description: `${delayed} successful payments (Rs. ${Math.round(Number(delayedValue._sum.amount ?? 0)).toLocaleString('en-US')}) missed their settlement window in the last 10 minutes.`,
      severity: delayed >= 100 ? 'HIGH' : 'MEDIUM',
      incidentType: 'SETTLEMENT',
      serviceIds: await serviceIds(['settlement-service']),
    })
  }

  const expected = config?.running ? config.tpm : null
  if (expected && streak('volume', totals.total >= Math.max(thresholds.rpmGate, expected * 2.5)) === 2) {
    await open({
      title: 'Transaction volume surge',
      description: `${totals.total} payments arrived in the last minute against a configured rate of ${expected} per minute.`,
      severity: 'MEDIUM',
      incidentType: 'VOLUME',
      serviceIds: await serviceIds(['payment-gateway']),
    })
  }

  const merchants = await prisma.transaction.groupBy({ by: ['merchantId'], where: { createdAt: { gte: since(3 * 60_000, now) } }, _count: { _all: true }, orderBy: { _count: { merchantId: 'desc' } }, take: 1 })
  const recentTotal = await prisma.transaction.count({ where: { createdAt: { gte: since(3 * 60_000, now) } } })
  const share = merchants[0] && recentTotal ? merchants[0]._count._all / recentTotal : 0
  if (streak('merchant', recentTotal >= 30 && share >= 0.25) === 2) {
    const merchant = await prisma.merchant.findUnique({ where: { id: merchants[0].merchantId } })
    await open({
      title: `Unusual activity concentration at ${merchant?.name ?? 'a merchant'}`,
      description: `${merchant?.name ?? 'One merchant'} accounted for ${(share * 100).toFixed(0)}% of payments in the last 3 minutes (${merchants[0]._count._all} of ${recentTotal}).`,
      severity: 'MEDIUM',
      incidentType: 'MERCHANT',
      serviceIds: await serviceIds(['merchant-api']),
    })
  }
  return raised
}

let timer: NodeJS.Timeout | null = null
let scanTimer: NodeJS.Timeout | null = null
let running = false
let scanning = false

export function startMonitoring() {
  if (!timer) {
    timer = setInterval(() => {
      if (running) return
      running = true
      evaluateIncidentRules()
        .catch((error) => logger.error('incident rules failed', { error: error instanceof Error ? error.message : 'unknown' }))
        .finally(() => { running = false })
    }, 5000)
  }
  if (!scanTimer) {
    scanTimer = setInterval(() => {
      if (scanning) return
      scanning = true
      import('./anomalyService.js')
        .then(({ scanWindows }) => scanWindows())
        .catch((error) => logger.error('anomaly scan failed', { error: error instanceof Error ? error.message : 'unknown' }))
        .finally(() => { scanning = false })
    }, 15000)
  }
}

export function stopMonitoring() {
  if (timer) clearInterval(timer)
  if (scanTimer) clearInterval(scanTimer)
  timer = null
  scanTimer = null
}
