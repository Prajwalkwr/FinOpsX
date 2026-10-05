import { Prisma, type ReportType } from '@prisma/client'
import ExcelJS from 'exceljs'
import { REPORT_LABEL, formatDuration, formatNpr, formatPercent } from '@finopsx/shared'
import type { Request } from 'express'
import { notFound, unprocessable } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { pageOf } from '../lib/http.js'
import { prisma, num } from '../lib/prisma.js'
import { buildSimplePdf } from '../utils/pdf.js'
import { resolveRange, type TimeRange } from '../utils/range.js'
import { toCsv, type Cell } from '../utils/csv.js'
import { writeAudit } from './audit.js'
import { sendEmail } from './email.js'
import { institutionPerformance, transactionAggregates, volumeSeries } from './metricsService.js'
import { notifyUsers } from './notify.js'

export const REPORT_SECTIONS: Record<ReportType, string[]> = {
  DAILY_OPERATIONS: ['kpis', 'volume', 'outcomes', 'institutions', 'incidents', 'anomalies', 'systemHealth', 'reconciliation'],
  TRANSACTION_SUMMARY: ['kpis', 'volume', 'outcomes', 'paymentMethods', 'failureReasons', 'institutions'],
  INSTITUTION_PERFORMANCE: ['kpis', 'institutions', 'failureReasons'],
  INCIDENT_REPORT: ['incidentKpis', 'incidents', 'systemHealth'],
  ANOMALY_REPORT: ['anomalyKpis', 'anomalies', 'anomalyTypes'],
  SYSTEM_HEALTH: ['systemHealth', 'apis', 'incidents'],
  RECONCILIATION_REPORT: ['reconciliation', 'settlements'],
}

function unitFor(from: Date, to: Date): TimeRange['unit'] {
  const span = to.getTime() - from.getTime()
  return span <= 6 * 3600_000 ? 'minute' : span <= 3 * 86400_000 ? 'hour' : 'day'
}

/** Builds a report snapshot from the same canonical aggregates the dashboard and AI use. */
export async function buildPayload(type: ReportType, from: Date, to: Date) {
  const range: TimeRange = { from, to, unit: unitFor(from, to), label: 'report' }
  const [metrics, volume, institutions, incidents, anomalies, anomalyTypes, reasons, methods, services, apiRows, reconRuns, settlements] = await Promise.all([
    transactionAggregates(range),
    volumeSeries(range),
    institutionPerformance(range),
    prisma.incident.findMany({
      where: { OR: [{ detectedAt: { gte: from, lte: to } }, { resolvedAt: { gte: from, lte: to } }] },
      orderBy: { detectedAt: 'desc' },
      take: 25,
      include: { services: { include: { service: true } }, assignee: true },
    }),
    prisma.anomaly.findMany({ where: { detectedAt: { gte: from, lte: to } }, orderBy: { detectedAt: 'desc' }, take: 25 }),
    prisma.anomaly.groupBy({ by: ['type'], where: { detectedAt: { gte: from, lte: to } }, _count: { _all: true } }),
    prisma.transaction.groupBy({ by: ['failureReason'], where: { status: 'FAILED', createdAt: { gte: from, lte: to } }, _count: { _all: true }, orderBy: { _count: { failureReason: 'desc' } } }),
    prisma.transaction.groupBy({ by: ['paymentMethod'], where: { createdAt: { gte: from, lte: to } }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.service.findMany({ orderBy: { name: 'asc' } }),
    prisma.$queryRaw<Array<{ key: string; total: number; errors: number; p95: number }>>(Prisma.sql`
      SELECT e.method || ' ' || e.endpoint AS key, COUNT(c.id)::int AS total, COUNT(c.id) FILTER (WHERE c."statusCode" >= 500)::int AS errors,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY c."latencyMs"), 0)::float AS p95
      FROM "ApiMetric" e JOIN "ApiCall" c ON c."endpointId" = e.id AND c."createdAt" >= ${from} AND c."createdAt" <= ${to}
      GROUP BY e.method, e.endpoint ORDER BY key`),
    prisma.reconciliationRun.findMany({ where: { createdAt: { gte: from, lte: new Date(to.getTime() + 86400_000) } }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.settlement.groupBy({ by: ['status'], where: { createdAt: { gte: from, lte: to } }, _count: { _all: true }, _sum: { amount: true, transactionCount: true } }),
  ])
  const resolved = incidents.filter((row) => row.resolvedAt)
  const mttrMinutes = resolved.length ? resolved.reduce((sum, row) => sum + (row.resolvedAt!.getTime() - row.detectedAt.getTime()), 0) / resolved.length / 60_000 : null
  const apiTotal = apiRows.reduce((sum, row) => sum + row.total, 0)
  const apiErrors = apiRows.reduce((sum, row) => sum + row.errors, 0)
  const worst = [...institutions].filter((row) => row.transactions >= 20).sort((a, b) => b.failureRate - a.failureRate)[0]
  const best = [...institutions].filter((row) => row.transactions >= 20).sort((a, b) => b.successRate - a.successRate)[0]
  const kpis = {
    total: metrics.total,
    successful: metrics.successful,
    failed: metrics.failed,
    pending: metrics.pending,
    reversed: metrics.reversed,
    settled: metrics.settled,
    successRate: metrics.successRate,
    failureRate: metrics.failureRate,
    value: metrics.value,
    successValue: metrics.successValue,
    avgLatencyMs: metrics.avgLatencyMs,
    p50Ms: metrics.p50Ms,
    p95Ms: metrics.p95Ms,
    p99Ms: metrics.p99Ms,
    incidents: incidents.length,
    criticalIncidents: incidents.filter((row) => row.severity === 'CRITICAL' || row.severity === 'HIGH').length,
    mttrMinutes,
    anomalies: anomalies.length,
    apiAvailability: apiTotal ? ((apiTotal - apiErrors) / apiTotal) * 100 : null,
  }
  const latestRecon = reconRuns[0]
  const summaryParts = [
    metrics.total
      ? `Between ${localStamp(from)} and ${localStamp(to)} (Nepal time) the platform processed ${metrics.total.toLocaleString('en-US')} synthetic transactions worth ${formatNpr(metrics.value)} with a ${formatPercent(metrics.successRate)} success rate.`
      : "I don't have enough data to summarise transactions for this window.",
    worst ? `${worst.name} had the highest failure rate (${formatPercent(worst.failureRate)}).` : '',
    reasons[0]?.failureReason ? `The most common failure reason was ${String(reasons[0].failureReason).replace(/_/g, ' ').toLowerCase()} (${reasons[0]._count._all}).` : '',
    incidents.length ? `${incidents.length} incident${incidents.length === 1 ? '' : 's'} were recorded${mttrMinutes != null ? `, with a mean time to resolve of ${mttrMinutes.toFixed(0)} minutes` : ''}.` : 'No incidents were recorded.',
    anomalies.length ? `${anomalies.length} operational anomal${anomalies.length === 1 ? 'y was' : 'ies were'} detected.` : '',
    latestRecon ? `Latest reconciliation ${latestRecon.publicId} was ${latestRecon.status} with ${latestRecon.unmatchedCount} unmatched records.` : '',
  ].filter(Boolean)
  return {
    type,
    title: REPORT_LABEL[type],
    sections: REPORT_SECTIONS[type],
    from: from.toISOString(),
    to: to.toISOString(),
    timezone: 'Asia/Kathmandu',
    synthetic: true,
    generatedAt: new Date().toISOString(),
    kpis,
    volume,
    outcomes: [
      { name: 'Successful', value: metrics.successful },
      { name: 'Failed', value: metrics.failed },
      { name: 'Pending', value: metrics.pending },
      { name: 'Reversed', value: metrics.reversed },
    ],
    paymentMethods: methods.map((row) => ({ method: row.paymentMethod, count: row._count._all, value: num(row._sum.amount) })).sort((a, b) => b.count - a.count),
    failureReasons: reasons.map((row) => ({ reason: row.failureReason ?? 'UNSPECIFIED', count: row._count._all })),
    institutions: institutions.map((row) => ({ name: row.name, code: row.code, transactions: row.transactions, successRate: row.successRate, failureRate: row.failureRate, avgResponseMs: row.avgResponseMs, value: row.value })),
    topInstitution: best?.name ?? null,
    highestFailureInstitution: worst?.name ?? null,
    incidents: incidents.map((row) => ({
      id: row.publicId,
      title: row.title,
      severity: row.severity,
      status: row.status,
      team: row.team,
      assignee: row.assignee?.name ?? null,
      detectedAt: row.detectedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      durationMinutes: row.resolvedAt ? Math.round((row.resolvedAt.getTime() - row.detectedAt.getTime()) / 60_000) : null,
      services: row.services.map((item) => item.service.name),
      rootCause: row.rootCause,
      rootCauseConfirmed: row.rootCauseConfirmed,
    })),
    anomalies: anomalies.map((row) => ({ id: row.publicId, type: row.type, severity: row.severity, status: row.status, title: row.title, entity: row.entityName, normalValue: row.normalValue, observedValue: row.observedValue, detectedAt: row.detectedAt.toISOString() })),
    anomalyTypes: anomalyTypes.map((row) => ({ type: row.type, count: row._count._all })),
    systemHealth: services.map((service) => ({ name: service.name, status: service.status, responseTimeMs: service.responseTimeMs, errorRate: service.errorRate, uptime: service.uptime })),
    apis: apiRows.map((row) => ({ endpoint: row.key, calls: row.total, errorRate: row.total ? (row.errors / row.total) * 100 : 0, p95Ms: Math.round(row.p95) })),
    reconciliation: reconRuns.map((row) => ({ id: row.publicId, status: row.status, windowFrom: row.windowFrom.toISOString(), windowTo: row.windowTo.toISOString(), expected: row.expectedCount, matched: row.matchedCount, unmatched: row.unmatchedCount, difference: num(row.difference), settlementDifference: num(row.settlementDifference) })),
    settlements: settlements.map((row) => ({ status: row.status, batches: row._count._all, transactions: row._sum.transactionCount ?? 0, amount: num(row._sum.amount ?? 0) })),
    aiSummary: `${summaryParts.join(' ')} AI-generated summary from synthetic data — verify before taking operational action.`,
  }
}

export type ReportPayload = Awaited<ReturnType<typeof buildPayload>>

const localDate = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kathmandu' })
const localStamp = (date: Date) => `${localDate(date)} ${date.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kathmandu', hour: '2-digit', minute: '2-digit', hour12: false })}`

export function reportTitle(type: ReportType, from: Date, to: Date) {
  const start = localDate(from)
  const end = localDate(new Date(to.getTime() - 1))
  return `${REPORT_LABEL[type]} · ${start}${end !== start ? ` to ${end}` : ''}`
}

export async function generateReport(input: { type: ReportType; from?: string; to?: string; userId?: string; source?: string; req?: Request; user?: AuthUser }) {
  const fallback = resolveRange({ range: 'today' })
  const from = input.from ? new Date(input.from) : fallback.from
  const to = input.to ? new Date(input.to) : fallback.to
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw unprocessable('Report dates must be valid ISO timestamps.')
  if (to <= from) throw unprocessable('Report end must be after its start.')
  if (to.getTime() - from.getTime() > 92 * 86400_000) throw unprocessable('Reports are limited to 92 days.')
  const payload = await buildPayload(input.type, from, to)
  const email = await sendEmail(input.user?.email ?? 'demo@finopsx.demo', `${REPORT_LABEL[input.type]} ready`, payload.aiSummary)
  const report = await prisma.report.create({
    data: {
      type: input.type,
      title: reportTitle(input.type, from, to),
      dateFrom: from,
      dateTo: to,
      payload: payload as unknown as Prisma.InputJsonValue,
      deliveryStatus: email.delivered ? 'SENT' : 'EMAIL_DISABLED',
      createdById: input.userId,
    },
  })
  if (input.user) {
    await writeAudit({ user: input.user, action: 'GENERATED_REPORT', resource: 'REPORT', resourceId: report.id, req: input.req, newValue: { type: input.type, from: from.toISOString(), to: to.toISOString() } })
    await notifyUsers({ userIds: [input.user.id], preference: 'notifyReports', type: 'REPORT', title: 'Report ready', message: report.title, severity: 'LOW', link: `/reports/${report.id}` })
  }
  return { ...report, email }
}

export async function listReports(page: number, limit: number, type?: string) {
  const where: Prisma.ReportWhereInput = type ? { type: type as ReportType } : {}
  const [total, rows] = await prisma.$transaction([
    prisma.report.count({ where }),
    prisma.report.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: { createdBy: true } }),
  ])
  return pageOf(rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    dateFrom: row.dateFrom.toISOString(),
    dateTo: row.dateTo.toISOString(),
    deliveryStatus: row.deliveryStatus,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy?.email ?? 'system',
  })), total, page, limit)
}

export async function getReport(id: string) {
  const row = await prisma.report.findUnique({ where: { id } })
  if (!row) throw notFound('Report not found.')
  return row
}

function tables(payload: ReportPayload): Array<{ name: string; columns: string[]; rows: Cell[][] }> {
  const out: Array<{ name: string; columns: string[]; rows: Cell[][] }> = []
  const has = (section: string) => payload.sections.includes(section)
  if (has('institutions')) out.push({ name: 'Institution performance', columns: ['Institution', 'Transactions', 'Success %', 'Failure %', 'Avg response (ms)', 'Value (NPR)'], rows: payload.institutions.map((row) => [row.name, row.transactions, Number(row.successRate.toFixed(2)), Number(row.failureRate.toFixed(2)), Math.round(row.avgResponseMs), Math.round(row.value)]) })
  if (has('paymentMethods')) out.push({ name: 'Payment methods', columns: ['Method', 'Transactions', 'Value (NPR)'], rows: payload.paymentMethods.map((row) => [row.method, row.count, Math.round(row.value)]) })
  if (has('failureReasons')) out.push({ name: 'Failure reasons', columns: ['Reason', 'Count'], rows: payload.failureReasons.map((row) => [row.reason, row.count]) })
  if (has('incidents')) out.push({ name: 'Incidents', columns: ['Incident', 'Severity', 'Status', 'Title', 'Detected', 'Duration (min)', 'Root cause'], rows: payload.incidents.map((row) => [row.id, row.severity, row.status, row.title, row.detectedAt, row.durationMinutes, row.rootCause ? `${row.rootCauseConfirmed ? 'Confirmed: ' : 'Likely: '}${row.rootCause}` : null]) })
  if (has('anomalies')) out.push({ name: 'Anomalies', columns: ['Anomaly', 'Type', 'Severity', 'Status', 'Entity', 'Normal', 'Observed', 'Detected'], rows: payload.anomalies.map((row) => [row.id, row.type, row.severity, row.status, row.entity, row.normalValue, row.observedValue, row.detectedAt]) })
  if (has('anomalyTypes')) out.push({ name: 'Anomalies by type', columns: ['Type', 'Count'], rows: payload.anomalyTypes.map((row) => [row.type, row.count]) })
  if (has('systemHealth')) out.push({ name: 'System health (at generation time)', columns: ['Service', 'Status', 'Response (ms)', 'Error %', 'Availability %'], rows: payload.systemHealth.map((row) => [row.name, row.status, row.responseTimeMs, Number(row.errorRate.toFixed(2)), Number(row.uptime.toFixed(2))]) })
  if (has('apis')) out.push({ name: 'API endpoints', columns: ['Endpoint', 'Calls', 'Error %', 'P95 (ms)'], rows: payload.apis.map((row) => [row.endpoint, row.calls, Number(row.errorRate.toFixed(2)), row.p95Ms]) })
  if (has('reconciliation')) out.push({ name: 'Reconciliation runs', columns: ['Run', 'Status', 'Expected', 'Matched', 'Unmatched', 'Ledger difference (NPR)', 'Unsettled value (NPR)'], rows: payload.reconciliation.map((row) => [row.id, row.status, row.expected, row.matched, row.unmatched, row.difference, row.settlementDifference]) })
  if (has('settlements')) out.push({ name: 'Settlement batches', columns: ['Status', 'Batches', 'Transactions', 'Amount (NPR)'], rows: payload.settlements.map((row) => [row.status, row.batches, row.transactions, Math.round(row.amount)]) })
  return out
}

function kpiLines(payload: ReportPayload) {
  const k = payload.kpis
  return [
    ['Total transactions', k.total.toLocaleString('en-US')],
    ['Successful (incl. settled)', k.successful.toLocaleString('en-US')],
    ['Failed', k.failed.toLocaleString('en-US')],
    ['Pending', k.pending.toLocaleString('en-US')],
    ['Reversed', k.reversed.toLocaleString('en-US')],
    ['Success rate', formatPercent(k.successRate)],
    ['Transaction value', formatNpr(k.value)],
    ['Average response', formatDuration(k.avgLatencyMs)],
    ['P95 / P99 response', `${formatDuration(k.p95Ms)} / ${formatDuration(k.p99Ms)}`],
    ['API availability', k.apiAvailability == null ? 'No API call data in window' : formatPercent(k.apiAvailability)],
    ['Incidents (high/critical)', `${k.incidents} (${k.criticalIncidents})`],
    ['Mean time to resolve', k.mttrMinutes == null ? 'n/a' : `${k.mttrMinutes.toFixed(0)} min`],
    ['Anomalies', String(k.anomalies)],
  ]
}

export async function renderReport(id: string, format: 'pdf' | 'csv' | 'xlsx') {
  const row = await getReport(id)
  const payload = row.payload as unknown as ReportPayload
  if (!payload.kpis) throw unprocessable('This report was generated by an older version and cannot be exported. Generate it again.')
  const sections = tables(payload)
  const safeName = row.title.replace(/[^\w.-]+/g, '-').slice(0, 60)
  if (format === 'pdf') {
    const lines = [
      `Window: ${payload.from} to ${payload.to} (displayed in ${payload.timezone})`,
      'FinOpsX - Demo Environment. Synthetic data only.',
      '',
      'Summary',
      payload.aiSummary,
      '',
      'Key metrics',
      ...kpiLines(payload).map(([label, value]) => `  ${label}: ${value}`),
      ...sections.flatMap((table) => ['', table.name, `  ${table.columns.join(' | ')}`, ...table.rows.slice(0, 40).map((cells) => `  ${cells.map((cell) => (cell == null ? '-' : String(cell))).join(' | ')}`)]),
    ]
    return { body: buildSimplePdf(row.title, lines), type: 'application/pdf', filename: `${safeName}.pdf` }
  }
  if (format === 'csv') {
    const blocks = [
      toCsv(['Section', 'Metric', 'Value'], [['Report', 'Title', row.title], ['Report', 'Window from', payload.from], ['Report', 'Window to', payload.to], ['Report', 'Data', 'Synthetic demo data'], ...kpiLines(payload).map(([label, value]) => ['KPI', label, value] as Cell[]), ['Summary', 'AI summary', payload.aiSummary]]),
      ...sections.map((table) => `\n${toCsv([table.name], [])}\n${toCsv(table.columns, table.rows)}`),
    ]
    return { body: Buffer.from(`\uFEFF${blocks.join('\n')}`), type: 'text/csv; charset=utf-8', filename: `${safeName}.csv` }
  }
  const workbook = new ExcelJS.Workbook()
  const summary = workbook.addWorksheet('Summary')
  summary.addRow(['FinOpsX — Demo Environment (synthetic data)'])
  summary.addRow([row.title])
  summary.addRow([`${payload.from} to ${payload.to}`])
  summary.addRow([])
  kpiLines(payload).forEach((line) => summary.addRow(line))
  summary.addRow([])
  summary.addRow([payload.aiSummary])
  for (const table of sections) {
    const sheet = workbook.addWorksheet(table.name.slice(0, 31).replace(/[\\/?*[\]:]/g, ''))
    sheet.addRow(table.columns)
    table.rows.forEach((cells) => sheet.addRow(cells))
  }
  const buffer = await workbook.xlsx.writeBuffer()
  return { body: Buffer.from(buffer), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${safeName}.xlsx` }
}

export async function deleteReport(id: string, user: AuthUser, req: Request) {
  const row = await getReport(id)
  await prisma.report.delete({ where: { id: row.id } })
  await writeAudit({ user, action: 'DELETED_REPORT', resource: 'REPORT', resourceId: id, req, previousValue: { type: row.type, title: row.title } })
}

export async function listSchedules() {
  const rows = await prisma.reportSchedule.findMany({ orderBy: { cadence: 'asc' } })
  return rows.map((row) => ({ ...row, email: 'Email delivery is disabled in the demo environment unless SMTP is configured.' }))
}

export async function updateSchedule(cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY', enabled: boolean, user: AuthUser, req: Request) {
  const next = enabled ? new Date(Date.now() + 86400_000) : null
  const existing = await prisma.reportSchedule.findUnique({ where: { cadence } })
  const row = await prisma.reportSchedule.upsert({
    where: { cadence },
    update: { enabled, nextRunAt: next, deliveryStatus: 'EMAIL_DISABLED' },
    create: { cadence, enabled, nextRunAt: next, deliveryStatus: 'EMAIL_DISABLED' },
  })
  await writeAudit({ user, action: 'UPDATED_REPORT_SCHEDULE', resource: 'REPORT_SCHEDULE', resourceId: cadence, req, previousValue: { enabled: existing?.enabled ?? null }, newValue: { enabled } })
  return row
}

export async function runDueSchedules() {
  const due = await prisma.reportSchedule.findMany({ where: { enabled: true, nextRunAt: { lte: new Date() } } })
  for (const schedule of due) {
    const range = resolveRange({ range: schedule.cadence === 'DAILY' ? 'yesterday' : schedule.cadence === 'WEEKLY' ? '7d' : '30d' })
    await generateReport({ type: schedule.reportType, from: range.from.toISOString(), to: range.to.toISOString(), source: 'schedule' })
    const next = new Date(Date.now() + (schedule.cadence === 'DAILY' ? 1 : schedule.cadence === 'WEEKLY' ? 7 : 30) * 86400_000)
    await prisma.reportSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: new Date(), nextRunAt: next, deliveryStatus: 'SIMULATED_DELIVERY' } })
  }
}

let scheduleTimer: NodeJS.Timeout | null = null
export function startReportScheduler() {
  if (scheduleTimer) return
  scheduleTimer = setInterval(() => { runDueSchedules().catch(() => undefined) }, 60_000)
}
