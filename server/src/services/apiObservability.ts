import { Prisma } from '@prisma/client'
import { notFound } from '../lib/errors.js'
import { prisma } from '../lib/prisma.js'
import { getThresholds } from './thresholds.js'

export const DEMO_ENDPOINTS = ['POST /payments', 'GET /payments/:id', 'POST /refund', 'POST /settlement', 'POST /qr/validate']

type EndpointAgg = {
  id: string
  total: number
  ok: number
  clientErrors: number
  serverErrors: number
  avg: number
  p50: number
  p95: number
  p99: number
}

async function aggregates(from: Date, endpointId?: string): Promise<EndpointAgg[]> {
  return prisma.$queryRaw<EndpointAgg[]>(Prisma.sql`
    SELECT "endpointId" AS id, COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "statusCode" < 400)::int AS ok,
      COUNT(*) FILTER (WHERE "statusCode" >= 400 AND "statusCode" < 500)::int AS "clientErrors",
      COUNT(*) FILTER (WHERE "statusCode" >= 500)::int AS "serverErrors",
      AVG("latencyMs")::float AS avg,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY "latencyMs")::float AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs")::float AS p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY "latencyMs")::float AS p99
    FROM "ApiCall" WHERE "createdAt" >= ${from} ${endpointId ? Prisma.sql`AND "endpointId" = ${endpointId}` : Prisma.empty}
    GROUP BY "endpointId"`)
}

function shape(agg: EndpointAgg | undefined, windowMinutes: number) {
  const total = agg?.total ?? 0
  return {
    calls: total,
    rpm: Number((total / windowMinutes).toFixed(1)),
    successRate: total ? (agg!.ok / total) * 100 : null,
    errorRate: total ? (agg!.serverErrors / total) * 100 : null,
    clientErrorRate: total ? (agg!.clientErrors / total) * 100 : null,
    availability: total ? ((total - agg!.serverErrors) / total) * 100 : null,
    avgLatencyMs: total ? Math.round(agg!.avg) : null,
    p50Ms: total ? Math.round(agg!.p50) : null,
    p95Ms: total ? Math.round(agg!.p95) : null,
    p99Ms: total ? Math.round(agg!.p99) : null,
  }
}

function statusFor(stats: ReturnType<typeof shape>, thresholds: { availabilityPct: number; latencyMs: number }) {
  if (stats.availability == null) return 'OPERATIONAL' as const
  if (stats.availability < thresholds.availabilityPct - 20) return 'INCIDENT' as const
  if (stats.availability < thresholds.availabilityPct || (stats.p95Ms ?? 0) > thresholds.latencyMs) return 'DEGRADED' as const
  return 'OPERATIONAL' as const
}

export async function listEndpoints(windowMinutes = 15) {
  const from = new Date(Date.now() - windowMinutes * 60_000)
  const [endpoints, aggs, thresholds] = await Promise.all([
    prisma.apiEndpoint.findMany({ include: { service: true }, orderBy: [{ service: { name: 'asc' } }, { endpoint: 'asc' }] }),
    aggregates(from),
    getThresholds(),
  ])
  return {
    windowMinutes,
    source: 'Synthetic API calls recorded by the demo simulator (ApiCall table).',
    items: endpoints.map((endpoint) => {
      const stats = shape(aggs.find((row) => row.id === endpoint.id), windowMinutes)
      const key = `${endpoint.method} ${endpoint.endpoint}`
      return {
        id: endpoint.id,
        name: endpoint.name || key,
        method: endpoint.method,
        endpoint: endpoint.endpoint,
        key,
        demo: DEMO_ENDPOINTS.includes(key),
        service: { id: endpoint.service.id, key: endpoint.service.key, name: endpoint.service.name },
        status: statusFor(stats, thresholds),
        ...stats,
      }
    }),
  }
}

/** Writes the current aggregates back to the endpoint registry so the service map and lists stay cheap. */
export async function refreshEndpointRegistry() {
  const { items } = await listEndpoints(5)
  for (const item of items) {
    await prisma.apiEndpoint.update({
      where: { id: item.id },
      data: {
        status: item.status,
        rpm: Math.round(item.rpm),
        latencyMs: item.avgLatencyMs ?? 0,
        errorRate: Number((item.errorRate ?? 0).toFixed(2)),
        p50Ms: item.p50Ms ?? 0,
        p95Ms: item.p95Ms ?? 0,
        p99Ms: item.p99Ms ?? 0,
        availability: Number((item.availability ?? 100).toFixed(2)),
      },
    })
  }
  return items
}

export async function getEndpoint(id: string, windowMinutes = 60) {
  const endpoint = await prisma.apiEndpoint.findUnique({ where: { id }, include: { service: true } })
  if (!endpoint) throw notFound('API endpoint not found.')
  const from = new Date(Date.now() - windowMinutes * 60_000)
  const [aggs, thresholds, series, statusCodes, byInstitution, recentErrors] = await Promise.all([
    aggregates(from, id),
    getThresholds(),
    prisma.$queryRaw<Array<{ minute: Date; total: number; errors: number; avg: number; p95: number }>>(Prisma.sql`
      SELECT date_trunc('minute', "createdAt") AS minute, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE "statusCode" >= 500)::int AS errors, AVG("latencyMs")::float AS avg,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs")::float AS p95
      FROM "ApiCall" WHERE "endpointId" = ${id} AND "createdAt" >= ${from}
      GROUP BY 1 ORDER BY 1`),
    prisma.apiCall.groupBy({ by: ['statusCode'], where: { endpointId: id, createdAt: { gte: from } }, _count: { _all: true }, orderBy: { statusCode: 'asc' } }),
    prisma.$queryRaw<Array<{ institutionId: string | null; name: string | null; total: number; errors: number; avg: number }>>(Prisma.sql`
      SELECT c."institutionId", i.name, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE c."statusCode" >= 500)::int AS errors, AVG(c."latencyMs")::float AS avg
      FROM "ApiCall" c LEFT JOIN "Institution" i ON i.id = c."institutionId"
      WHERE c."endpointId" = ${id} AND c."createdAt" >= ${from}
      GROUP BY c."institutionId", i.name ORDER BY total DESC`),
    prisma.apiCall.findMany({ where: { endpointId: id, createdAt: { gte: from }, statusCode: { gte: 400 } }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])
  const stats = shape(aggs[0], windowMinutes)
  const institutions = await prisma.institution.findMany({ select: { id: true, name: true } })
  const key = `${endpoint.method} ${endpoint.endpoint}`
  return {
    id: endpoint.id,
    name: endpoint.name || key,
    key,
    method: endpoint.method,
    endpoint: endpoint.endpoint,
    demo: DEMO_ENDPOINTS.includes(key),
    service: { id: endpoint.service.id, key: endpoint.service.key, name: endpoint.service.name, status: endpoint.service.status },
    windowMinutes,
    status: statusFor(stats, thresholds),
    thresholds: { availabilityPct: thresholds.availabilityPct, latencyMs: thresholds.latencyMs },
    ...stats,
    series: series.map((row) => ({
      time: row.minute.toISOString(),
      rpm: row.total,
      errorRate: row.total ? Number(((row.errors / row.total) * 100).toFixed(2)) : 0,
      avgLatencyMs: Math.round(row.avg),
      p95Ms: Math.round(row.p95),
    })),
    statusCodes: statusCodes.map((row) => ({ code: row.statusCode, count: row._count._all, class: `${String(row.statusCode)[0]}xx` })),
    institutions: byInstitution.map((row) => ({
      name: row.name ?? 'Platform',
      calls: row.total,
      errorRate: row.total ? (row.errors / row.total) * 100 : 0,
      avgLatencyMs: Math.round(row.avg),
    })),
    recentErrors: recentErrors.map((row) => ({
      statusCode: row.statusCode,
      latencyMs: row.latencyMs,
      transactionRef: row.transactionRef,
      institution: institutions.find((item) => item.id === row.institutionId)?.name ?? null,
      at: row.createdAt.toISOString(),
    })),
  }
}
