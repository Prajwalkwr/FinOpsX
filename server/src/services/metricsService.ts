import { Prisma } from '@prisma/client'
import { ACTIVE_INCIDENT_STATUSES, isSuccessStatus } from '@finopsx/shared'
import { prisma, num } from '../lib/prisma.js'
import { resolveRange, type TimeRange } from '../utils/range.js'

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

const ACTIVE = [...ACTIVE_INCIDENT_STATUSES]

/**
 * Canonical transaction aggregate. Dashboard, analytics, reports and the AI assistant all call this,
 * so every surface reports the same totals for the same window.
 */
export async function transactionAggregates(range: Pick<TimeRange, 'from' | 'to'>, filter: Prisma.TransactionWhereInput = {}) {
  const where: Prisma.TransactionWhereInput = { ...filter, createdAt: { gte: range.from, lte: range.to } }
  const institutionId = typeof filter.institutionId === 'string' ? filter.institutionId : null
  const [grouped, latency, percentiles] = await Promise.all([
    prisma.transaction.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { amount: true } }),
    prisma.transaction.aggregate({ where, _avg: { responseTimeMs: true } }),
    prisma.$queryRaw<Array<{ p50: number | null; p95: number | null; p99: number | null }>>(Prisma.sql`
      SELECT
        percentile_cont(0.50) WITHIN GROUP (ORDER BY "responseTimeMs") AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "responseTimeMs") AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY "responseTimeMs") AS p99
      FROM "Transaction"
      WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to}
      ${institutionId ? Prisma.sql`AND "institutionId" = ${institutionId}` : Prisma.empty}
    `),
  ])
  const counts: Record<string, number> = {}
  let value = 0
  let successValue = 0
  for (const row of grouped) {
    counts[row.status] = row._count._all
    value += num(row._sum.amount)
    if (isSuccessStatus(row.status)) successValue += num(row._sum.amount)
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const successful = (counts.SUCCESS ?? 0) + (counts.SETTLED ?? 0)
  const failed = counts.FAILED ?? 0
  const pending = (counts.PENDING ?? 0) + (counts.INITIATED ?? 0) + (counts.PROCESSING ?? 0)
  return {
    total,
    counts,
    successful,
    failed,
    pending,
    reversed: (counts.REVERSED ?? 0) + (counts.REFUNDED ?? 0),
    settled: counts.SETTLED ?? 0,
    value,
    successValue,
    successRate: total ? (successful / total) * 100 : 0,
    failureRate: total ? (failed / total) * 100 : 0,
    pendingRate: total ? (pending / total) * 100 : 0,
    avgLatencyMs: latency._avg.responseTimeMs ?? 0,
    p50Ms: Number(percentiles[0]?.p50 ?? 0),
    p95Ms: Number(percentiles[0]?.p95 ?? 0),
    p99Ms: Number(percentiles[0]?.p99 ?? 0),
  }
}

export async function apiAvailability(from: Date, to = new Date()) {
  const rows = await prisma.$queryRaw<Array<{ total: number; ok: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE "statusCode" < 500)::int AS ok
    FROM "ApiCall" WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}`)
  const total = rows[0]?.total ?? 0
  return { total, availability: total ? (rows[0].ok / total) * 100 : null }
}

export async function healthScore(range: TimeRange) {
  const [metrics, incidents, anomalies, availability] = await Promise.all([
    transactionAggregates(range),
    prisma.incident.findMany({ where: { status: { in: ACTIVE } } }),
    prisma.anomaly.count({ where: { status: { in: ['DETECTED', 'REVIEW'] } } }),
    apiAvailability(new Date(Date.now() - 60 * 60_000)),
  ])
  const avail = availability.availability ?? 100
  const availabilityPoints = (avail / 100) * 40
  const successPoints = (metrics.successRate / 100) * 30
  const latencyPoints = Math.max(0, 15 - (metrics.avgLatencyMs / 5000) * 15)
  const incidentPenalty = incidents.reduce((sum, incident) => sum + (incident.severity === 'CRITICAL' ? 6 : incident.severity === 'HIGH' ? 3 : 1), 0)
  const incidentPoints = Math.max(0, 10 - incidentPenalty)
  const anomalyPoints = Math.max(0, 5 - anomalies)
  const score = Math.round(clamp(availabilityPoints + successPoints + latencyPoints + incidentPoints + anomalyPoints, 0, 100))
  return { score, availability: avail, incidents: incidents.length, anomalies, metrics }
}

export async function volumeSeries(range: TimeRange, filter: { institutionId?: string } = {}) {
  const unit = range.unit === 'minute' ? 'minute' : range.unit === 'hour' ? 'hour' : 'day'
  const rows = await prisma.$queryRaw<Array<{ bucket: Date; status: string; count: number; value: number }>>(Prisma.sql`
    SELECT date_trunc(${unit}, "createdAt") AS bucket, status::text AS status, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS value
    FROM "Transaction"
    WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to}
    ${filter.institutionId ? Prisma.sql`AND "institutionId" = ${filter.institutionId}` : Prisma.empty}
    GROUP BY 1, 2 ORDER BY 1 ASC`)
  const map = new Map<string, { time: string; success: number; failed: number; pending: number; other: number; value: number }>()
  for (const row of rows) {
    const time = new Date(row.bucket).toISOString()
    const entry = map.get(time) ?? { time, success: 0, failed: 0, pending: 0, other: 0, value: 0 }
    const count = Number(row.count)
    if (isSuccessStatus(row.status)) entry.success += count
    else if (row.status === 'FAILED') entry.failed += count
    else if (['PENDING', 'INITIATED', 'PROCESSING'].includes(row.status)) entry.pending += count
    else entry.other += count
    entry.value += Number(row.value)
    map.set(time, entry)
  }
  return [...map.values()]
}

export async function institutionPerformance(range: Pick<TimeRange, 'from' | 'to'>) {
  const [rows, institutions, lastIncidents, apiRows] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['institutionId', 'status'],
      where: { createdAt: { gte: range.from, lte: range.to } },
      _count: { _all: true },
      _sum: { amount: true },
      _avg: { responseTimeMs: true },
    }),
    prisma.institution.findMany(),
    prisma.incident.findMany({ where: { institutions: { some: {} } }, orderBy: { createdAt: 'desc' }, include: { institutions: true }, take: 40 }),
    prisma.$queryRaw<Array<{ institutionId: string; total: number; ok: number }>>(Prisma.sql`
      SELECT "institutionId", COUNT(*)::int AS total, COUNT(*) FILTER (WHERE "statusCode" < 500)::int AS ok
      FROM "ApiCall" WHERE "createdAt" >= ${new Date(Date.now() - 60 * 60_000)} AND "institutionId" IS NOT NULL
      GROUP BY 1`),
  ])
  return institutions.map((institution) => {
    const related = rows.filter((row) => row.institutionId === institution.id)
    const total = related.reduce((sum, row) => sum + row._count._all, 0)
    const failed = related.find((row) => row.status === 'FAILED')?._count._all ?? 0
    const success = related.filter((row) => isSuccessStatus(row.status)).reduce((sum, row) => sum + row._count._all, 0)
    const value = related.reduce((sum, row) => sum + num(row._sum.amount), 0)
    const latency = total ? related.reduce((sum, row) => sum + (row._avg.responseTimeMs ?? 0) * row._count._all, 0) / total : 0
    const incident = lastIncidents.find((item) => item.institutions.some((link) => link.institutionId === institution.id))
    const api = apiRows.find((row) => row.institutionId === institution.id)
    return {
      id: institution.id,
      name: institution.name,
      code: institution.code,
      type: institution.type,
      status: institution.status,
      transactions: total,
      successRate: total ? (success / total) * 100 : 0,
      failureRate: total ? (failed / total) * 100 : 0,
      failures: failed,
      avgResponseMs: latency,
      value,
      apiAvailability: api && api.total ? (api.ok / api.total) * 100 : null,
      apiCalls: api?.total ?? 0,
      lastIncident: incident ? { id: incident.publicId, title: incident.title, status: incident.status } : null,
    }
  }).sort((a, b) => b.transactions - a.transactions)
}

export async function systemStatus() {
  const services = await prisma.service.findMany({ orderBy: { name: 'asc' } })
  const overall = services.some((service) => service.status === 'INCIDENT')
    ? 'Incident'
    : services.some((service) => service.status === 'DEGRADED')
      ? 'Degraded'
      : services.some((service) => service.status === 'MAINTENANCE')
        ? 'Maintenance'
        : 'All Systems Operational'
  return { overall, services }
}

export async function dashboardSummary(query: { range?: string; from?: string; to?: string }) {
  const range = resolveRange(query)
  const [score, status, alerts, recent, activeIncidents] = await Promise.all([
    healthScore(range),
    systemStatus(),
    prisma.anomaly.findMany({ where: { detectedAt: { gte: range.from, lte: range.to } }, orderBy: { detectedAt: 'desc' }, take: 5, include: { institution: true, merchant: true } }),
    prisma.transaction.findMany({ where: { createdAt: { gte: range.from, lte: range.to } }, orderBy: { createdAt: 'desc' }, take: 8, include: { institution: true, merchant: true } }),
    prisma.incident.count({ where: { status: { in: ACTIVE } } }),
  ])
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label },
    timezone: 'Asia/Kathmandu',
    synthetic: true,
    kpis: {
      total: score.metrics.total,
      successful: score.metrics.successful,
      failed: score.metrics.failed,
      pending: score.metrics.pending,
      successRate: score.metrics.successRate,
      value: score.metrics.value,
      activeIncidents,
      apiAvailability: score.availability,
      avgResponseMs: score.metrics.avgLatencyMs,
    },
    healthScore: score.score,
    systemStatus: status.overall,
    services: status.services.map(serializeService),
    alerts: alerts.map((alert) => ({ id: alert.publicId, type: alert.type, severity: alert.severity, title: alert.title, score: alert.score, link: `/anomalies/${alert.publicId}` })),
    topInstitutions: (await institutionPerformance(range)).slice(0, 5),
    recent: recent.map(serializeTransaction),
  }
}

/** Overview payload for the main dashboard. Every number is computed from stored rows for the selected window. */
export async function dashboardOverview(query: { range?: string; from?: string; to?: string }) {
  const range = resolveRange(query)
  const hourAgo = new Date(Date.now() - 60 * 60_000)
  const [metrics, status, volume, availability, activeIncidents, anomalies, institutions, recent, methods, openAnomalies] = await Promise.all([
    transactionAggregates(range),
    systemStatus(),
    volumeSeries(range),
    apiAvailability(hourAgo),
    prisma.incident.findMany({
      where: { status: { in: ACTIVE } },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 6,
      include: { assignee: true, services: { include: { service: true } } },
    }),
    prisma.anomaly.findMany({ orderBy: { detectedAt: 'desc' }, take: 6, include: { institution: true, merchant: true } }),
    institutionPerformance(range),
    prisma.transaction.findMany({ where: { createdAt: { gte: range.from, lte: range.to } }, orderBy: { createdAt: 'desc' }, take: 8, include: { institution: true, merchant: true } }),
    prisma.transaction.groupBy({ by: ['paymentMethod'], where: { createdAt: { gte: range.from, lte: range.to } }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.anomaly.count({ where: { status: { in: ['DETECTED', 'REVIEW'] } } }),
  ])
  const aiAlerts = buildAiAlerts({ metrics, institutions, incidents: activeIncidents, openAnomalies })
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label, unit: range.unit },
    timezone: 'Asia/Kathmandu',
    synthetic: true,
    systemStatus: status.overall,
    kpis: {
      total: metrics.total,
      successful: metrics.successful,
      failed: metrics.failed,
      pending: metrics.pending,
      successRate: metrics.successRate,
      failureRate: metrics.failureRate,
      value: metrics.value,
      activeIncidents: activeIncidents.length,
      apiAvailability: availability.availability,
      apiCallsLastHour: availability.total,
      avgResponseMs: metrics.avgLatencyMs,
      p95Ms: metrics.p95Ms,
      openAnomalies,
    },
    volume,
    outcomes: [
      { name: 'Successful', value: metrics.successful },
      { name: 'Failed', value: metrics.failed },
      { name: 'Pending', value: metrics.pending },
      { name: 'Reversed', value: metrics.reversed },
    ],
    paymentMethods: methods.map((row) => ({ method: row.paymentMethod, count: row._count._all, value: num(row._sum.amount) })).sort((a, b) => b.count - a.count),
    services: status.services.map(serializeService),
    aiAlerts,
    activeIncidents: activeIncidents.map((row) => ({
      id: row.publicId,
      title: row.title,
      severity: row.severity,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      assignee: row.assignee?.name ?? null,
      services: row.services.map((item) => item.service.name),
    })),
    institutions,
    anomalies: anomalies.map((row) => ({
      id: row.publicId,
      type: row.type,
      severity: row.severity,
      status: row.status,
      title: row.title,
      entity: row.entityName ?? row.institution?.name ?? row.merchant?.name ?? 'Platform',
      normalValue: row.normalValue,
      observedValue: row.observedValue,
      detectedAt: row.detectedAt.toISOString(),
    })),
    recent: recent.map(serializeTransaction),
  }
}

function buildAiAlerts(input: {
  metrics: Awaited<ReturnType<typeof transactionAggregates>>
  institutions: Awaited<ReturnType<typeof institutionPerformance>>
  incidents: Array<{ publicId: string; title: string; severity: string }>
  openAnomalies: number
}) {
  const alerts: Array<{ id: string; tone: 'info' | 'warn' | 'bad'; message: string; href: string }> = []
  const active = input.institutions.filter((row) => row.transactions >= 20)
  const worst = [...active].sort((a, b) => b.failureRate - a.failureRate)[0]
  if (worst && input.metrics.failureRate > 0 && worst.failureRate > input.metrics.failureRate * 1.5) {
    alerts.push({ id: `inst-${worst.code}`, tone: 'warn', message: `${worst.name} failure rate is ${worst.failureRate.toFixed(1)}%, against ${input.metrics.failureRate.toFixed(1)}% overall.`, href: `/institutions/${worst.id}` })
  }
  const slow = [...active].sort((a, b) => b.avgResponseMs - a.avgResponseMs)[0]
  if (slow && slow.avgResponseMs > 1500) {
    alerts.push({ id: `lat-${slow.code}`, tone: 'warn', message: `${slow.name} average response time is ${(slow.avgResponseMs / 1000).toFixed(1)}s.`, href: `/institutions/${slow.id}` })
  }
  for (const incident of input.incidents.slice(0, 2)) {
    alerts.push({ id: incident.publicId, tone: incident.severity === 'CRITICAL' || incident.severity === 'HIGH' ? 'bad' : 'warn', message: `${incident.publicId} is active: ${incident.title}.`, href: `/incidents/${incident.publicId}` })
  }
  const open = input.openAnomalies
  if (open) alerts.push({ id: 'anomalies', tone: 'info', message: `${open} operational anomal${open === 1 ? 'y needs' : 'ies need'} review.`, href: '/anomalies?status=DETECTED' })
  return alerts
}

export function serializeService(service: { id: string; key: string; name: string; status: string; responseTimeMs: number; uptime: number; errorRate?: number; lastCheckedAt: Date }) {
  return {
    id: service.id,
    key: service.key,
    name: service.name,
    status: service.status,
    responseTimeMs: service.responseTimeMs,
    uptime: service.uptime,
    errorRate: service.errorRate ?? 0,
    lastCheckedAt: service.lastCheckedAt.toISOString(),
  }
}

export function serializeTransaction(row: {
  id: string
  transactionId: string
  customerId: string
  amount: { toNumber: () => number } | number
  currency: string
  paymentMethod: string
  status: string
  responseTimeMs: number
  riskScore: number
  failureReason: string | null
  settlementStatus: string
  notificationStatus: string
  correlationId: string
  apiEndpoint: string
  suspicious: boolean
  createdAt: Date
  updatedAt?: Date
  responseCode?: string | null
  serviceKey?: string
  lifecycleStage?: string
  merchantReference?: string | null
  institution?: { id: string; name: string; code: string } | null
  destinationInstitution?: { id: string; name: string; code: string } | null
  merchant?: { id: string; name: string; code: string } | null
}) {
  return {
    id: row.id,
    transactionId: row.transactionId,
    customerId: row.customerId,
    amount: num(row.amount),
    currency: row.currency,
    paymentMethod: row.paymentMethod,
    status: row.status,
    responseTimeMs: row.responseTimeMs,
    responseCode: row.responseCode ?? null,
    riskScore: row.riskScore,
    failureReason: row.failureReason,
    settlementStatus: row.settlementStatus,
    notificationStatus: row.notificationStatus,
    correlationId: row.correlationId,
    apiEndpoint: row.apiEndpoint,
    serviceKey: row.serviceKey ?? 'payment-api',
    lifecycleStage: row.lifecycleStage ?? 'COMPLETED',
    merchantReference: row.merchantReference ?? null,
    suspicious: row.suspicious,
    createdAt: row.createdAt.toISOString(),
    updatedAt: (row.updatedAt ?? row.createdAt).toISOString(),
    institution: row.institution ? { id: row.institution.id, name: row.institution.name, code: row.institution.code } : null,
    destinationInstitution: row.destinationInstitution ? { id: row.destinationInstitution.id, name: row.destinationInstitution.name, code: row.destinationInstitution.code } : null,
    merchant: row.merchant ? { id: row.merchant.id, name: row.merchant.name, code: row.merchant.code } : null,
  }
}

export { resolveRange }
