import { Prisma } from '@prisma/client'
import { prisma, num } from '../lib/prisma.js'
import { resolveRange, type TimeRange } from '../utils/range.js'

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export async function transactionAggregates(range: TimeRange) {
  const where = { createdAt: { gte: range.from, lte: range.to } }
  const [grouped, latency, percentiles] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({ where, _avg: { responseTimeMs: true } }),
    prisma.$queryRaw<Array<{ p95: number | null; p99: number | null }>>(Prisma.sql`
      SELECT
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "responseTimeMs") AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY "responseTimeMs") AS p99
      FROM "Transaction"
      WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to}
    `),
  ])
  const counts = { SUCCESS: 0, FAILED: 0, PENDING: 0, CANCELLED: 0, REFUNDED: 0 }
  let value = 0
  for (const row of grouped) {
    counts[row.status] = row._count._all
    value += num(row._sum.amount)
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const successRate = total ? (counts.SUCCESS / total) * 100 : 0
  const failureRate = total ? (counts.FAILED / total) * 100 : 0
  const pendingRate = total ? (counts.PENDING / total) * 100 : 0
  return {
    total,
    counts,
    value,
    successRate,
    failureRate,
    pendingRate,
    avgLatencyMs: latency._avg.responseTimeMs ?? 0,
    p95Ms: Number(percentiles[0]?.p95 ?? 0),
    p99Ms: Number(percentiles[0]?.p99 ?? 0),
  }
}

export async function healthScore(range: TimeRange) {
  const [metrics, services, incidents, anomalies] = await Promise.all([
    transactionAggregates(range),
    prisma.service.findMany(),
    prisma.incident.findMany({ where: { status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
    prisma.anomaly.count({ where: { status: { in: ['DETECTED', 'REVIEW'] } } }),
  ])
  const availability = services.length
    ? services.reduce((sum, service) => sum + service.uptime, 0) / services.length
    : 100
  const availabilityPoints = (availability / 100) * 40
  const successPoints = (metrics.successRate / 100) * 30
  const latencyPoints = Math.max(0, 15 - (metrics.avgLatencyMs / 5000) * 15)
  const incidentPenalty = incidents.reduce((sum, incident) => {
    if (incident.severity === 'CRITICAL') return sum + 6
    if (incident.severity === 'HIGH') return sum + 3
    return sum + 1
  }, 0)
  const incidentPoints = Math.max(0, 10 - incidentPenalty)
  const anomalyPoints = Math.max(0, 5 - anomalies)
  const score = Math.round(clamp(availabilityPoints + successPoints + latencyPoints + incidentPoints + anomalyPoints, 0, 100))
  return { score, availability, incidents: incidents.length, anomalies, metrics }
}

export async function volumeSeries(range: TimeRange) {
  const rows =
    range.unit === 'minute'
      ? await prisma.$queryRaw<Array<{ bucket: Date; status: string; count: number }>>(Prisma.sql`
          SELECT date_trunc('minute', "createdAt") AS bucket, status, COUNT(*)::int AS count
          FROM "Transaction"
          WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to}
          GROUP BY 1, 2 ORDER BY 1 ASC`)
      : range.unit === 'hour'
        ? await prisma.$queryRaw<Array<{ bucket: Date; status: string; count: number }>>(Prisma.sql`
            SELECT date_trunc('hour', "createdAt") AS bucket, status, COUNT(*)::int AS count
            FROM "Transaction"
            WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to}
            GROUP BY 1, 2 ORDER BY 1 ASC`)
        : await prisma.$queryRaw<Array<{ bucket: Date; status: string; count: number }>>(Prisma.sql`
            SELECT date_trunc('day', "createdAt") AS bucket, status, COUNT(*)::int AS count
            FROM "Transaction"
            WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to}
            GROUP BY 1, 2 ORDER BY 1 ASC`)
  const map = new Map<string, { time: string; success: number; failed: number; pending: number }>()
  for (const row of rows) {
    const time = new Date(row.bucket).toISOString()
    const entry = map.get(time) ?? { time, success: 0, failed: 0, pending: 0 }
    if (row.status === 'SUCCESS') entry.success += Number(row.count)
    else if (row.status === 'FAILED') entry.failed += Number(row.count)
    else entry.pending += Number(row.count)
    map.set(time, entry)
  }
  return [...map.values()]
}

export async function institutionPerformance(range: TimeRange) {
  const rows = await prisma.transaction.groupBy({
    by: ['institutionId', 'status'],
    where: { createdAt: { gte: range.from, lte: range.to } },
    _count: { _all: true },
    _sum: { amount: true },
    _avg: { responseTimeMs: true },
  })
  const institutions = await prisma.institution.findMany()
  const lastIncidents = await prisma.incident.findMany({
    where: { institutions: { some: {} } },
    orderBy: { createdAt: 'desc' },
    include: { institutions: true },
    take: 30,
  })
  return institutions.map((institution) => {
    const related = rows.filter((row) => row.institutionId === institution.id)
    const total = related.reduce((sum, row) => sum + row._count._all, 0)
    const failed = related.find((row) => row.status === 'FAILED')?._count._all ?? 0
    const success = related.find((row) => row.status === 'SUCCESS')?._count._all ?? 0
    const value = related.reduce((sum, row) => sum + num(row._sum.amount), 0)
    const latency = related.length
      ? related.reduce((sum, row) => sum + (row._avg.responseTimeMs ?? 0) * row._count._all, 0) / Math.max(1, total)
      : 0
    const incident = lastIncidents.find((item) => item.institutions.some((link) => link.institutionId === institution.id))
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
      apiAvailability: institution.status === 'OPERATIONAL' ? 99.7 : institution.status === 'DEGRADED' ? 97.4 : 94.2,
      lastIncident: incident ? { id: incident.publicId, title: incident.title, status: incident.status } : null,
    }
  }).sort((a, b) => b.transactions - a.transactions)
}

export async function dashboardSummary(query: { range?: string; from?: string; to?: string }) {
  const range = resolveRange(query)
  const [score, services, alerts, recent, activeIncidents] = await Promise.all([
    healthScore(range),
    prisma.service.findMany({ orderBy: { name: 'asc' } }),
    prisma.anomaly.findMany({
      where: { detectedAt: { gte: range.from, lte: range.to } },
      orderBy: { detectedAt: 'desc' },
      take: 5,
      include: { institution: true, merchant: true },
    }),
    prisma.transaction.findMany({
      where: { createdAt: { gte: range.from, lte: range.to } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { institution: true, merchant: true },
    }),
    prisma.incident.count({ where: { status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
  ])
  const apiAvailability = services.length
    ? services.reduce((sum, service) => sum + service.uptime, 0) / services.length
    : 0
  const overall = services.some((service) => service.status === 'INCIDENT')
    ? 'Incident'
    : services.some((service) => service.status === 'DEGRADED')
      ? 'Degraded'
      : services.some((service) => service.status === 'MAINTENANCE')
        ? 'Maintenance'
        : 'All Systems Operational'
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label },
    timezone: 'Asia/Kathmandu',
    synthetic: true,
    kpis: {
      total: score.metrics.total,
      successful: score.metrics.counts.SUCCESS,
      failed: score.metrics.counts.FAILED,
      pending: score.metrics.counts.PENDING,
      successRate: score.metrics.successRate,
      value: score.metrics.value,
      activeIncidents,
      apiAvailability,
      avgResponseMs: score.metrics.avgLatencyMs,
    },
    healthScore: score.score,
    systemStatus: overall,
    services: services.map((service) => ({
      id: service.id,
      key: service.key,
      name: service.name,
      status: service.status,
      responseTimeMs: service.responseTimeMs,
      uptime: service.uptime,
      lastCheckedAt: service.lastCheckedAt.toISOString(),
    })),
    alerts: alerts.map((alert) => ({
      id: alert.publicId,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      score: alert.score,
      link: `/anomalies`,
    })),
    topInstitutions: (await institutionPerformance(range)).slice(0, 5),
    recent: recent.map(serializeTransaction),
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
  institution?: { id: string; name: string; code: string } | null
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
    riskScore: row.riskScore,
    failureReason: row.failureReason,
    settlementStatus: row.settlementStatus,
    notificationStatus: row.notificationStatus,
    correlationId: row.correlationId,
    apiEndpoint: row.apiEndpoint,
    suspicious: row.suspicious,
    createdAt: row.createdAt.toISOString(),
    institution: row.institution ?? null,
    merchant: row.merchant ?? null,
  }
}

export { resolveRange }
