import { Prisma } from '@prisma/client'
import { can, type AiAction, type Role } from '@finopsx/shared'
import { forbidden } from '../../lib/errors.js'
import { num, prisma } from '../../lib/prisma.js'
import { resolveRange } from '../../utils/range.js'
import { listEndpoints } from '../apiObservability.js'
import { dataQualityOverview } from '../dataQualityService.js'
import type { StructuredQuery } from './queryParser.js'

import type { Cell } from '../../utils/csv.js'

export type { Cell }
export type QueryResult = {
  columns: string[]
  rows: Cell[][]
  rowLinks: Array<string | null>
  total: number
  summary: string
  range: { from: string; to: string; label: string }
  actions: AiAction[]
}

const PERMISSION: Record<StructuredQuery['entity'], Parameters<typeof can>[1]> = {
  transactions: 'transactions:view',
  incidents: 'incidents:view',
  anomalies: 'anomalies:view',
  settlements: 'reconciliation:view',
  api_endpoints: 'apis:view',
  jobs: 'jobs:view',
  data_quality: 'dataquality:view',
}

export function canRunQuery(role: Role, query: StructuredQuery) {
  if (query.entity === 'transactions' && query.mode === 'aggregate') return can(role, 'transactions:view') || can(role, 'analytics:view')
  return can(role, PERMISSION[query.entity])
}

const GROUP_SQL: Record<string, string> = {
  institution: 'i.name',
  merchant: 'm.name',
  payment_method: 't."paymentMethod"::text',
  status: 't.status::text',
  failure_reason: `COALESCE(t."failureReason"::text, 'UNSPECIFIED')`,
  hour: `date_trunc('hour', t."createdAt")`,
  day: `date_trunc('day', t."createdAt" + interval '345 minutes')`,
}

const METRIC_SQL: Record<string, string> = {
  count: 'COUNT(*)::float',
  sum_amount: 'COALESCE(SUM(t.amount), 0)::float',
  avg_amount: 'COALESCE(AVG(t.amount), 0)::float',
  failure_rate: `(COUNT(*) FILTER (WHERE t.status = 'FAILED')::float / NULLIF(COUNT(*), 0)) * 100`,
  success_rate: `(COUNT(*) FILTER (WHERE t.status IN ('SUCCESS', 'SETTLED'))::float / NULLIF(COUNT(*), 0)) * 100`,
  avg_latency: 'COALESCE(AVG(t."responseTimeMs"), 0)::float',
  p95_latency: 'COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY t."responseTimeMs"), 0)::float',
}

export const METRIC_LABEL: Record<string, string> = {
  count: 'Transactions',
  sum_amount: 'Value (NPR)',
  avg_amount: 'Average amount (NPR)',
  failure_rate: 'Failure rate (%)',
  success_rate: 'Success rate (%)',
  avg_latency: 'Average response (ms)',
  p95_latency: 'P95 response (ms)',
}

const localLabel = (date: Date, unit: 'hour' | 'day') =>
  unit === 'hour'
    ? date.toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toISOString().slice(0, 10)

function round(value: number, metric: string) {
  if (metric === 'count') return Math.round(value)
  if (metric.endsWith('_rate')) return Number(value.toFixed(2))
  return Math.round(value)
}

async function txConditions(query: StructuredQuery, from: Date, to: Date) {
  const f = query.filters
  const parts: Prisma.Sql[] = [Prisma.sql`t."createdAt" >= ${from}`, Prisma.sql`t."createdAt" <= ${to}`]
  if (f.status?.length) parts.push(Prisma.sql`t.status::text IN (${Prisma.join(f.status)})`)
  if (f.institution) parts.push(Prisma.sql`i.code = ${f.institution}`)
  if (f.paymentMethod) parts.push(Prisma.sql`t."paymentMethod"::text = ${f.paymentMethod}`)
  if (f.failureReason) parts.push(Prisma.sql`t."failureReason"::text = ${f.failureReason}`)
  if (f.minAmount != null) parts.push(Prisma.sql`t.amount >= ${f.minAmount}`)
  if (f.maxAmount != null) parts.push(Prisma.sql`t.amount <= ${f.maxAmount}`)
  if (f.merchant) parts.push(Prisma.sql`m.name ILIKE ${`%${f.merchant}%`}`)
  return Prisma.join(parts, ' AND ')
}

function txWhere(query: StructuredQuery, from: Date, to: Date): Prisma.TransactionWhereInput {
  const f = query.filters
  return {
    createdAt: { gte: from, lte: to },
    ...(f.status?.length ? { status: { in: f.status } } : {}),
    ...(f.institution ? { institution: { code: f.institution } } : {}),
    ...(f.paymentMethod ? { paymentMethod: f.paymentMethod } : {}),
    ...(f.failureReason ? { failureReason: f.failureReason } : {}),
    ...(f.minAmount != null || f.maxAmount != null ? { amount: { ...(f.minAmount != null ? { gte: f.minAmount } : {}), ...(f.maxAmount != null ? { lte: f.maxAmount } : {}) } } : {}),
    ...(f.merchant ? { merchant: { name: { contains: f.merchant, mode: 'insensitive' } } } : {}),
  }
}

function transactionLink(query: StructuredQuery) {
  const params = new URLSearchParams()
  if (query.filters.status?.length === 1) params.set('status', query.filters.status[0])
  if (query.filters.institution) params.set('institution', query.filters.institution)
  if (query.filters.paymentMethod) params.set('paymentMethod', query.filters.paymentMethod)
  if (query.filters.failureReason) params.set('failureReason', query.filters.failureReason)
  if (query.filters.minAmount != null) params.set('minAmount', String(query.filters.minAmount))
  params.set('range', query.range)
  return `/transactions?${params.toString()}`
}

/** Executes a validated structured query with role checks. Callers must validate with structuredQuerySchema first. */
export async function executeQuery(query: StructuredQuery, role: Role, options: { maxRows?: number } = {}): Promise<QueryResult> {
  if (!canRunQuery(role, query)) throw forbidden(`Your role cannot query ${query.entity.replace('_', ' ')}.`)
  const range = resolveRange({ range: query.range })
  const rangeOut = { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label }
  const limit = Math.min(options.maxRows ?? query.limit, options.maxRows ?? 200)

  if (query.entity === 'transactions') {
    const conditions = await txConditions(query, range.from, range.to)
    if (query.mode === 'aggregate') {
      const metric = query.metric ?? 'count'
      const metricSql = Prisma.raw(METRIC_SQL[metric])
      if (!query.groupBy) {
        const [row] = await prisma.$queryRaw<Array<{ value: number | null; total: number }>>(Prisma.sql`
          SELECT ${metricSql} AS value, COUNT(*)::int AS total
          FROM "Transaction" t JOIN "Institution" i ON i.id = t."institutionId" JOIN "Merchant" m ON m.id = t."merchantId"
          WHERE ${conditions}`)
        const total = row?.total ?? 0
        const value = row?.value == null ? null : round(Number(row.value), metric)
        return {
          columns: ['Metric', 'Value', 'Transactions in scope'],
          rows: [[METRIC_LABEL[metric], value, total]],
          rowLinks: [transactionLink(query)],
          total,
          summary: total ? `${METRIC_LABEL[metric]}: ${value?.toLocaleString('en-US')} across ${total.toLocaleString('en-US')} transactions (${range.label}).` : `No transactions match these filters in ${range.label}.`,
          range: rangeOut,
          actions: [{ label: 'Open matching transactions', href: transactionLink(query) }],
        }
      }
      const groupSql = Prisma.raw(GROUP_SQL[query.groupBy])
      const order = query.groupBy === 'hour' || query.groupBy === 'day' ? Prisma.raw('1 ASC') : Prisma.raw(`2 ${query.sort?.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`)
      const rows = await prisma.$queryRaw<Array<{ key: string | Date | null; value: number | null; total: number }>>(Prisma.sql`
        SELECT ${groupSql} AS key, ${metricSql} AS value, COUNT(*)::int AS total
        FROM "Transaction" t JOIN "Institution" i ON i.id = t."institutionId" JOIN "Merchant" m ON m.id = t."merchantId"
        WHERE ${conditions}
        GROUP BY 1 ORDER BY ${order} LIMIT ${limit}`)
      const total = rows.reduce((sum, row) => sum + row.total, 0)
      const label = (key: string | Date | null) => (key instanceof Date ? localLabel(key, query.groupBy === 'hour' ? 'hour' : 'day') : key ?? 'Unspecified')
      const top = rows[0]
      return {
        columns: [query.groupBy.replace('_', ' ').replace(/^./, (c) => c.toUpperCase()), METRIC_LABEL[metric], 'Transactions'],
        rows: rows.map((row) => [label(row.key), row.value == null ? null : round(Number(row.value), metric), row.total]),
        rowLinks: rows.map(() => null),
        total,
        summary: top
          ? query.groupBy === 'hour' || query.groupBy === 'day'
            ? `${rows.length} ${query.groupBy === 'hour' ? 'hourly' : 'daily'} buckets covering ${total.toLocaleString('en-US')} transactions (${range.label}).`
            : `${label(top.key)} ranks ${query.sort?.dir === 'asc' ? 'lowest' : 'highest'} by ${METRIC_LABEL[metric].toLowerCase()} at ${round(Number(top.value ?? 0), metric).toLocaleString('en-US')} (${range.label}).`
          : `No transactions match these filters in ${range.label}.`,
        range: rangeOut,
        actions: [{ label: 'Open matching transactions', href: transactionLink(query) }],
      }
    }
    const where = txWhere(query, range.from, range.to)
    const [total, rows] = await prisma.$transaction([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({ where, orderBy: query.sort?.field === 'amount' ? { amount: query.sort.dir } : { createdAt: 'desc' }, take: limit, include: { institution: true, merchant: true } }),
    ])
    return {
      columns: ['Transaction', 'Created', 'Institution', 'Merchant', 'Method', 'Status', 'Amount (NPR)', 'Response (ms)', 'Failure reason'],
      rows: rows.map((row) => [row.transactionId, row.createdAt.toISOString(), row.institution.name, row.merchant.name, row.paymentMethod, row.status, num(row.amount), row.responseTimeMs, row.failureReason]),
      rowLinks: rows.map((row) => `/transactions/${row.transactionId}`),
      total,
      summary: total ? `${total.toLocaleString('en-US')} transactions match (${range.label}); showing ${rows.length}.` : `No transactions match these filters in ${range.label}.`,
      range: rangeOut,
      actions: [{ label: 'Open in Transactions', href: transactionLink(query) }],
    }
  }

  if (query.entity === 'incidents' || query.entity === 'anomalies') {
    const isIncident = query.entity === 'incidents'
    const activeIncident = ['DETECTED', 'ACKNOWLEDGED', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATING'] as const
    const activeAnomaly = ['DETECTED', 'REVIEW', 'CONFIRMED'] as const
    const common = {
      ...(query.filters.activeOnly ? {} : { [isIncident ? 'createdAt' : 'detectedAt']: { gte: range.from, lte: range.to } }),
      ...(query.filters.severity ? { severity: query.filters.severity } : {}),
    }
    const incidentWhere: Prisma.IncidentWhereInput = { ...common, ...(query.filters.activeOnly ? { status: { in: [...activeIncident] } } : {}) }
    const anomalyWhere: Prisma.AnomalyWhereInput = { ...common, ...(query.filters.activeOnly ? { status: { in: [...activeAnomaly] } } : {}) }
    if (query.mode === 'aggregate' && query.groupBy) {
      const field = query.groupBy === 'type' ? (isIncident ? 'incidentType' : 'type') : 'severity'
      const grouped = isIncident
        ? await prisma.incident.groupBy({ by: [field as 'severity'], where: incidentWhere, _count: { _all: true } })
        : await prisma.anomaly.groupBy({ by: [field as 'severity'], where: anomalyWhere, _count: { _all: true } })
      const rows = (grouped as Array<Record<string, unknown> & { _count: { _all: number } }>).map((row) => [String(row[field]), row._count._all] as Cell[]).sort((a, b) => Number(b[1]) - Number(a[1]))
      const total = rows.reduce((sum, row) => sum + Number(row[1]), 0)
      return { columns: [field, 'Count'], rows, rowLinks: rows.map(() => null), total, summary: `${total} ${query.entity} (${query.filters.activeOnly ? 'active' : range.label}).`, range: rangeOut, actions: [{ label: `Open ${query.entity}`, href: `/${query.entity}` }] }
    }
    if (isIncident) {
      const [total, rows] = await prisma.$transaction([
        prisma.incident.count({ where: incidentWhere }),
        prisma.incident.findMany({ where: incidentWhere, orderBy: { createdAt: 'desc' }, take: limit }),
      ])
      return {
        columns: ['Incident', 'Title', 'Severity', 'Status', 'Detected'],
        rows: rows.map((row) => [row.publicId, row.title, row.severity, row.status, row.detectedAt.toISOString()]),
        rowLinks: rows.map((row) => `/incidents/${row.publicId}`),
        total,
        summary: total ? `${total} incident${total === 1 ? '' : 's'} (${query.filters.activeOnly ? 'active now' : range.label}).` : `No incidents match (${query.filters.activeOnly ? 'active now' : range.label}).`,
        range: rangeOut,
        actions: [{ label: 'Open incidents', href: query.filters.activeOnly ? '/incidents?active=true' : '/incidents' }],
      }
    }
    const [total, rows] = await prisma.$transaction([
      prisma.anomaly.count({ where: anomalyWhere }),
      prisma.anomaly.findMany({ where: anomalyWhere, orderBy: { detectedAt: 'desc' }, take: limit }),
    ])
    return {
      columns: ['Anomaly', 'Title', 'Severity', 'Status', 'Normal', 'Observed', 'Detected'],
      rows: rows.map((row) => [row.publicId, row.title, row.severity, row.status, row.normalValue, row.observedValue, row.detectedAt.toISOString()]),
      rowLinks: rows.map((row) => `/anomalies?focus=${row.publicId}`),
      total,
      summary: total ? `${total} anomal${total === 1 ? 'y' : 'ies'} (${query.filters.activeOnly ? 'open now' : range.label}).` : `No anomalies match (${range.label}).`,
      range: rangeOut,
      actions: [{ label: 'Open anomalies', href: '/anomalies' }],
    }
  }

  if (query.entity === 'settlements') {
    const where: Prisma.SettlementWhereInput = { createdAt: { gte: range.from, lte: range.to }, ...(query.filters.institution ? { institution: { code: query.filters.institution } } : {}) }
    const [total, rows, sum] = await Promise.all([
      prisma.settlement.count({ where }),
      prisma.settlement.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, include: { institution: true } }),
      prisma.settlement.aggregate({ where, _sum: { amount: true, transactionCount: true } }),
    ])
    return {
      columns: ['Batch', 'Institution', 'Status', 'Transactions', 'Amount (NPR)', 'Created'],
      rows: rows.map((row) => [row.publicId, row.institution.name, row.status, row.transactionCount, num(row.amount), row.createdAt.toISOString()]),
      rowLinks: rows.map(() => '/reconciliation'),
      total,
      summary: total ? `${total} settlement batches covering ${(sum._sum.transactionCount ?? 0).toLocaleString('en-US')} payments worth Rs. ${Math.round(num(sum._sum.amount ?? 0)).toLocaleString('en-US')} (${range.label}).` : `No settlement batches in ${range.label}.`,
      range: rangeOut,
      actions: [{ label: 'Open reconciliation', href: '/reconciliation' }],
    }
  }

  if (query.entity === 'api_endpoints') {
    const minutes = Math.max(5, Math.min(360, Math.round((range.to.getTime() - range.from.getTime()) / 60_000)))
    const { items } = await listEndpoints(minutes)
    const metric = query.metric === 'p95_latency' ? 'p95Ms' : 'avgLatencyMs'
    const sorted = [...items].sort((a, b) => (b[metric] ?? 0) - (a[metric] ?? 0)).slice(0, limit)
    const withCalls = sorted.filter((row) => row.calls > 0)
    return {
      columns: ['Endpoint', 'Service', 'RPM', 'Avg (ms)', 'P95 (ms)', 'P99 (ms)', 'Error rate (%)', 'Availability (%)'],
      rows: sorted.map((row) => [row.key, row.service.name, row.rpm, row.avgLatencyMs, row.p95Ms, row.p99Ms, row.errorRate == null ? null : Number(row.errorRate.toFixed(2)), row.availability == null ? null : Number(row.availability.toFixed(2))]),
      rowLinks: sorted.map((row) => `/system-health/apis/${row.id}`),
      total: sorted.length,
      summary: withCalls[0] ? `${withCalls[0].key} is slowest by ${metric === 'p95Ms' ? 'P95' : 'average'} latency over the last ${minutes} minutes.` : `No API calls were recorded in the last ${minutes} minutes.`,
      range: { ...rangeOut, label: `last ${minutes} minutes (API call retention is 6 hours)` },
      actions: [{ label: 'Open System Health', href: '/system-health' }],
    }
  }

  if (query.entity === 'jobs') {
    const where: Prisma.OperationalJobWhereInput = { createdAt: { gte: range.from, lte: range.to } }
    const [total, rows] = await prisma.$transaction([
      prisma.operationalJob.count({ where }),
      prisma.operationalJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
    ])
    return {
      columns: ['Job', 'Type', 'Status', 'Processed', 'Failed', 'Triggered by', 'Created'],
      rows: rows.map((row) => [row.publicId, row.type, row.status, row.recordsProcessed, row.failedRecords, row.triggeredBy, row.createdAt.toISOString()]),
      rowLinks: rows.map(() => '/jobs'),
      total,
      summary: total ? `${total} operational job runs (${range.label}).` : `No operational jobs ran in ${range.label}.`,
      range: rangeOut,
      actions: [{ label: 'Open operational jobs', href: '/jobs' }],
    }
  }

  const overview = await dataQualityOverview()
  const open = overview.issues.filter((issue) => issue.status !== 'RESOLVED')
  return {
    columns: ['Issue', 'Check', 'Affected records', 'Affected %', 'Status'],
    rows: overview.issues.map((issue) => [issue.id, issue.title, issue.affectedCount, Number(issue.affectedPct.toFixed(3)), issue.status]),
    rowLinks: overview.issues.map((issue) => `/data-quality?issue=${issue.id}`),
    total: overview.issues.length,
    summary: overview.lastCheckedAt ? `${open.length} open data quality issues; completeness ${overview.metrics.completeness.toFixed(2)}%, accuracy ${overview.metrics.accuracy.toFixed(2)}%.` : "I don't have enough data to answer that. The data quality scan has not run yet.",
    range: rangeOut,
    actions: [{ label: 'Open data quality', href: '/data-quality' }],
  }
}

export { toCsv } from '../../utils/csv.js'
