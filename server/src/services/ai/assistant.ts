import { Prisma } from '@prisma/client'
import { can, formatDuration, formatNpr, formatPercent, type AiAction, type Permission, type Role } from '@finopsx/shared'
import { env } from '../../config/env.js'
import { prisma } from '../../lib/prisma.js'
import { resolveRange, type TimeRange } from '../../utils/range.js'
import { listEndpoints } from '../apiObservability.js'
import { dataQualityOverview } from '../dataQualityService.js'
import { ACTIVE_STATUSES } from '../incidentService.js'
import { institutionPerformance, transactionAggregates } from '../metricsService.js'
import { reconciliationSummary } from '../reconciliationService.js'
import type { RcaResult } from '../rcaService.js'
import { executeQuery, type Cell } from './queryExecutor.js'
import { parseQuestion, parseRange, type StructuredQuery } from './queryParser.js'

export const NO_DATA = "I don't have enough data to answer that."

export type ToolName =
  | 'overview'
  | 'explainChange'
  | 'incidentDetail'
  | 'activeIncidents'
  | 'anomalies'
  | 'settlements'
  | 'jobs'
  | 'dataQuality'
  | 'apiMetrics'
  | 'systemHealth'
  | 'institutions'
  | 'busiestHour'
  | 'paymentMethods'
  | 'generateReport'
  | 'dataQuery'

export type ToolResult = {
  tool: ToolName
  status: 'ANSWERED' | 'NO_DATA' | 'FORBIDDEN'
  summary: string
  evidence: string[]
  explanation?: string
  nextSteps: string[]
  actions: AiAction[]
  table?: { columns: string[]; rows: Cell[][] }
  reportId?: string
  structuredQuery?: StructuredQuery
  resultCount?: number
}

const LIMITATION = 'AI-generated analysis from synthetic demo data — verify before taking operational action.'

const TOOL_PERMISSION: Record<ToolName, Permission[]> = {
  overview: ['dashboard:view'],
  explainChange: ['transactions:view', 'analytics:view'],
  incidentDetail: ['incidents:view'],
  activeIncidents: ['incidents:view'],
  anomalies: ['anomalies:view'],
  settlements: ['reconciliation:view'],
  jobs: ['jobs:view'],
  dataQuality: ['dataquality:view'],
  apiMetrics: ['apis:view'],
  systemHealth: ['system:view'],
  institutions: ['institutions:view', 'analytics:view'],
  busiestHour: ['transactions:view', 'analytics:view'],
  paymentMethods: ['transactions:view', 'analytics:view'],
  generateReport: ['reports:generate'],
  dataQuery: ['transactions:view', 'analytics:view', 'incidents:view', 'anomalies:view', 'apis:view', 'jobs:view', 'dataquality:view', 'reconciliation:view'],
}

export function routeIntent(question: string): ToolName {
  const q = question.toLowerCase()
  if (/\binc-\d+\b/.test(q)) return 'incidentDetail'
  if (/\bwhy\b/.test(q) && /\b(fail|failure|declin|latenc|slow|increase|spike|drop|down)/.test(q)) return 'explainChange'
  if (/\b(generate|create|build|make)\b.*\breport\b/.test(q)) return 'generateReport'
  if (/\bincidents?\b/.test(q) && !/\b(by|per) (severity|type)\b/.test(q)) return 'activeIncidents'
  if (/\b(anomal|unusual|abnormal)/.test(q) && !/\b(by|per) (severity|type)\b/.test(q)) return 'anomalies'
  if (/\b(settle|settlement|reconcil)/.test(q)) return 'settlements'
  if (/\b(jobs?|eod|bod|end of day|beginning of day)\b/.test(q)) return 'jobs'
  if (/\bdata quality\b|\bduplicate|missing (fields?|reference)|invalid (customer|ids?)/.test(q)) return 'dataQuality'
  if (/\b(api|apis|endpoints?)\b/.test(q)) return 'apiMetrics'
  if (/\b(system health|service status|services|health score|is (everything|the system) (ok|healthy|up))\b/.test(q)) return 'systemHealth'
  if (/\bbusiest\b|\bpeak hour\b/.test(q)) return 'busiestHour'
  if (/\bpayment methods?\b/.test(q) && /\bfail/.test(q)) return 'paymentMethods'
  if (/\b(which|compare|rank)\b.*\b(bank|institution)s?\b|\b(bank|institution) (performance|comparison)\b/.test(q)) return 'institutions'
  if (/\b(overview|summary|summarise|summarize|how (are|is) (we|things|it) doing|status today|kpis?)\b/.test(q) && !/\bby\b/.test(q)) return 'overview'
  return 'dataQuery'
}

function windowLabel(range: TimeRange) {
  return range.label === 'Today' ? 'today' : range.label === 'Yesterday' ? 'yesterday' : `the last ${range.label}`
}

async function overview(question: string): Promise<ToolResult> {
  const range = resolveRange({ range: parseRange(question.toLowerCase()) })
  const [metrics, incidents, anomalies] = await Promise.all([
    transactionAggregates(range),
    prisma.incident.findMany({ where: { status: { in: ACTIVE_STATUSES } }, orderBy: { createdAt: 'desc' }, take: 3 }),
    prisma.anomaly.count({ where: { status: { in: ['DETECTED', 'REVIEW'] } } }),
  ])
  if (!metrics.total) return { tool: 'overview', status: 'NO_DATA', summary: `${NO_DATA} There are no transactions in ${windowLabel(range)}.`, evidence: [], nextSteps: ['Start the demo simulator or pick a wider time range.'], actions: [{ label: 'Open Demo Simulator', href: '/demo-simulator' }] }
  return {
    tool: 'overview',
    status: 'ANSWERED',
    summary: `${metrics.total.toLocaleString('en-US')} transactions in ${windowLabel(range)} with a ${formatPercent(metrics.successRate)} success rate and ${formatNpr(metrics.value)} processed.`,
    evidence: [
      `${metrics.successful.toLocaleString('en-US')} successful, ${metrics.failed.toLocaleString('en-US')} failed, ${metrics.pending.toLocaleString('en-US')} pending, ${metrics.reversed.toLocaleString('en-US')} reversed.`,
      `Average response ${formatDuration(metrics.avgLatencyMs)}, P95 ${formatDuration(metrics.p95Ms)}.`,
      incidents.length ? `${incidents.length} active incident${incidents.length === 1 ? '' : 's'}: ${incidents.map((row) => `${row.publicId} ${row.title}`).join('; ')}.` : 'No active incidents.',
      `${anomalies} anomal${anomalies === 1 ? 'y' : 'ies'} awaiting review.`,
    ],
    nextSteps: incidents.length ? ['Open the active incident and review its root cause analysis.'] : ['Review institutions with the highest failure rate.'],
    actions: [{ label: 'Open Overview', href: `/?range=${range.label === 'Today' ? 'today' : '24h'}` }, ...incidents.slice(0, 2).map((row) => ({ label: row.publicId, href: `/incidents/${row.publicId}` }))],
  }
}

async function explainChange(question: string): Promise<ToolResult> {
  const q = question.toLowerCase()
  const now = Date.now()
  const span = /\btoday\b/.test(q) ? now - resolveRange({ range: 'today' }).from.getTime() : 60 * 60_000
  const current = { from: new Date(now - span), to: new Date(now) }
  const previous = { from: new Date(now - 2 * span), to: new Date(now - span) }
  const [cur, prev, curInst, prevInst, reasons, prevReasons, incidents, anomalies] = await Promise.all([
    transactionAggregates(current),
    transactionAggregates(previous),
    institutionPerformance(current),
    institutionPerformance(previous),
    prisma.transaction.groupBy({ by: ['failureReason'], where: { status: 'FAILED', createdAt: { gte: current.from, lte: current.to } }, _count: { _all: true }, orderBy: { _count: { failureReason: 'desc' } }, take: 3 }),
    prisma.transaction.groupBy({ by: ['failureReason'], where: { status: 'FAILED', createdAt: { gte: previous.from, lte: previous.to } }, _count: { _all: true } }),
    prisma.incident.findMany({ where: { OR: [{ status: { in: ACTIVE_STATUSES } }, { detectedAt: { gte: current.from } }] }, orderBy: { detectedAt: 'desc' }, take: 3 }),
    prisma.anomaly.findMany({
      where: { detectedAt: { gte: current.from }, type: { in: /\b(latenc|slow)/.test(q) ? ['API_LATENCY_SPIKE'] : ['FAILURE_RATE_SPIKE', 'REPEATED_FAILURE', 'API_LATENCY_SPIKE'] } },
      orderBy: { detectedAt: 'desc' },
      take: 3,
    }),
  ])
  const label = span === 60 * 60_000 ? 'the last hour' : 'today so far'
  if (cur.total < 20 || prev.total < 20) {
    return { tool: 'explainChange', status: 'NO_DATA', summary: `${NO_DATA} There are only ${cur.total} transactions in ${label} and ${prev.total} in the period before, which is too few to compare.`, evidence: [], nextSteps: ['Start the demo simulator and ask again in a few minutes.'], actions: [{ label: 'Open Demo Simulator', href: '/demo-simulator' }] }
  }
  const latencyQuestion = /\b(latenc|slow)/.test(q)
  const deltas = curInst.map((row) => {
    const before = prevInst.find((item) => item.id === row.id)
    return { row, failureDelta: row.failureRate - (before?.failureRate ?? 0), latencyBefore: before?.avgResponseMs ?? 0, latencyRatio: before?.avgResponseMs ? row.avgResponseMs / before.avgResponseMs : 0 }
  }).filter((item) => item.row.transactions >= 5)
  const driver = latencyQuestion ? [...deltas].sort((a, b) => b.latencyRatio - a.latencyRatio)[0] : [...deltas].sort((a, b) => b.failureDelta - a.failureDelta)[0]
  const topReason = reasons[0]
  const topReasonBefore = prevReasons.find((row) => row.failureReason === topReason?.failureReason)?._count._all ?? 0
  const changed = latencyQuestion ? cur.avgLatencyMs > prev.avgLatencyMs * 1.2 : cur.failureRate > prev.failureRate * 1.2 && cur.failureRate - prev.failureRate >= 0.5
  const evidence = [
    latencyQuestion
      ? `Average response moved from ${formatDuration(prev.avgLatencyMs)} to ${formatDuration(cur.avgLatencyMs)} (P95 ${formatDuration(prev.p95Ms)} → ${formatDuration(cur.p95Ms)}).`
      : `Failure rate moved from ${formatPercent(prev.failureRate)} (${prev.failed}/${prev.total}) to ${formatPercent(cur.failureRate)} (${cur.failed}/${cur.total}).`,
    driver ? `${driver.row.name}: failure ${formatPercent(driver.row.failureRate)} (${driver.failureDelta >= 0 ? '+' : ''}${driver.failureDelta.toFixed(1)} pts), response ${formatDuration(driver.latencyBefore)} → ${formatDuration(driver.row.avgResponseMs)}.` : '',
    topReason?.failureReason ? `Top failure reason now: ${String(topReason.failureReason).replace(/_/g, ' ').toLowerCase()} (${topReason._count._all}, was ${topReasonBefore}).` : '',
    ...incidents.map((row) => `Incident ${row.publicId} (${row.status}): ${row.title}.`),
    ...anomalies.map((row) => `Anomaly ${row.publicId}: ${row.title}.`),
    prev.total < 100 ? `The comparison period has only ${prev.total} transactions, so treat the size of the change as indicative.` : '',
  ].filter(Boolean)
  const rca = incidents.find((row) => row.rca)?.rca as unknown as RcaResult | undefined
  const explanation = !changed
    ? `${latencyQuestion ? 'Latency' : 'The failure rate'} in ${label} is not materially higher than the period before, so there is no change to explain.`
    : rca?.likelyCause
      ? `Likely cause (from incident analysis): ${rca.likelyCause}`
      : driver && (latencyQuestion ? driver.latencyRatio >= 1.5 : driver.failureDelta >= 2)
        ? `Likely cause: the change is concentrated at ${driver.row.name}${topReason?.failureReason ? `, mostly ${String(topReason.failureReason).replace(/_/g, ' ').toLowerCase()} failures` : ''}${driver.latencyRatio >= 1.5 ? `, alongside a ${driver.latencyRatio.toFixed(1)}× slower response time` : ''}. This is a correlation in synthetic data, not proof of cause.`
        : 'The change is spread across institutions with no single dominant driver in the data.'
  return {
    tool: 'explainChange',
    status: 'ANSWERED',
    summary: changed
      ? `${latencyQuestion ? 'Latency' : 'Failures'} increased in ${label} compared with the period before.`
      : `${latencyQuestion ? 'Latency' : 'Failures'} did not increase materially in ${label}.`,
    evidence,
    explanation,
    nextSteps: changed ? ['Open the affected institution and review its failed transactions.', 'Check the related incident timeline and its root cause analysis.'] : ['Nothing to investigate right now; keep monitoring the overview.'],
    actions: [
      ...(driver ? [{ label: `${driver.row.name} details`, href: `/institutions/${driver.row.id}` }, { label: `Failed at ${driver.row.name}`, href: `/transactions?status=FAILED&institution=${driver.row.code}` }] : []),
      ...incidents.slice(0, 2).map((row) => ({ label: `Incident ${row.publicId}`, href: `/incidents/${row.publicId}` })),
      ...anomalies.slice(0, 1).map((row) => ({ label: `Anomaly ${row.publicId}`, href: `/anomalies?focus=${row.publicId}` })),
    ],
  }
}

async function incidentDetail(question: string): Promise<ToolResult> {
  const id = question.toUpperCase().match(/INC-\d+/)?.[0]
  const incident = id ? await prisma.incident.findUnique({ where: { publicId: id }, include: { services: { include: { service: true } }, institutions: { include: { institution: true } }, assignee: true } }) : null
  if (!incident) return { tool: 'incidentDetail', status: 'NO_DATA', summary: `${NO_DATA} I could not find incident ${id ?? ''}.`.trim(), evidence: [], nextSteps: ['Check the incident ID on the Incidents page.'], actions: [{ label: 'Open incidents', href: '/incidents' }] }
  const rca = incident.rca as unknown as RcaResult | null
  return {
    tool: 'incidentDetail',
    status: 'ANSWERED',
    summary: `${incident.publicId} — ${incident.title} is ${incident.status} (${incident.severity}).`,
    evidence: [
      `Detected ${incident.detectedAt.toISOString()}${incident.resolvedAt ? `, resolved ${incident.resolvedAt.toISOString()}` : ''}.`,
      `Services: ${incident.services.map((row) => row.service.name).join(', ') || 'none linked'}; institutions: ${incident.institutions.map((row) => row.institution.name).join(', ') || 'none linked'}.`,
      `Owner: ${incident.assignee?.name ?? 'unassigned'}${incident.team ? ` (${incident.team})` : ''}.`,
      ...(rca?.evidence.filter((item) => item.supports).slice(0, 4).map((item) => `${item.label}: ${item.value}`) ?? []),
    ],
    explanation: incident.rootCauseConfirmed && incident.rootCause
      ? `Confirmed root cause: ${incident.rootCause}`
      : rca?.likelyCause
        ? `Likely cause (${rca.confidenceLabel.toLowerCase()} confidence): ${rca.likelyCause}`
        : 'No likely cause has been identified yet from the available metrics.',
    nextSteps: rca?.recommendedActions ?? ['Open the incident and review the timeline.'],
    actions: [{ label: `Open ${incident.publicId}`, href: `/incidents/${incident.publicId}` }, ...(rca?.actions ?? []).slice(0, 3)],
  }
}

async function activeIncidents(): Promise<ToolResult> {
  const rows = await prisma.incident.findMany({ where: { status: { in: ACTIVE_STATUSES } }, orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }], take: 10, include: { assignee: true } })
  const recent = rows.length ? [] : await prisma.incident.findMany({ orderBy: { createdAt: 'desc' }, take: 3 })
  return {
    tool: 'activeIncidents',
    status: 'ANSWERED',
    summary: rows.length ? `${rows.length} active incident${rows.length === 1 ? '' : 's'}.` : 'There are no active incidents right now.',
    evidence: rows.length
      ? rows.map((row) => `${row.publicId} ${row.severity} ${row.status}: ${row.title} — ${row.assignee?.name ?? 'unassigned'}.`)
      : recent.map((row) => `Most recent: ${row.publicId} (${row.status}) ${row.title}.`),
    nextSteps: rows.length ? ['Acknowledge unowned incidents and assign an engineer.'] : ['No action needed.'],
    actions: rows.length ? rows.slice(0, 3).map((row) => ({ label: row.publicId, href: `/incidents/${row.publicId}` })) : [{ label: 'Open incidents', href: '/incidents' }],
    table: rows.length ? { columns: ['Incident', 'Severity', 'Status', 'Title'], rows: rows.map((row) => [row.publicId, row.severity, row.status, row.title]) } : undefined,
    resultCount: rows.length,
  }
}

async function anomalies(): Promise<ToolResult> {
  const rows = await prisma.anomaly.findMany({ where: { status: { in: ['DETECTED', 'REVIEW', 'CONFIRMED'] } }, orderBy: { detectedAt: 'desc' }, take: 8 })
  return {
    tool: 'anomalies',
    status: 'ANSWERED',
    summary: rows.length ? `${rows.length} open operational anomal${rows.length === 1 ? 'y' : 'ies'}.` : 'No open operational anomalies.',
    evidence: rows.map((row) => `${row.publicId} ${row.severity}: ${row.description}`),
    explanation: 'Operational anomaly detection compares a recent window with a moving baseline (z-score) or a threshold. It is not fraud detection.',
    nextSteps: rows.length ? ['Review each anomaly and confirm, dismiss, or link it to an incident.'] : ['No action needed.'],
    actions: rows.length ? rows.slice(0, 3).map((row) => ({ label: row.publicId, href: `/anomalies?focus=${row.publicId}` })) : [{ label: 'Open anomalies', href: '/anomalies' }],
    table: rows.length ? { columns: ['Anomaly', 'Severity', 'Normal', 'Observed', 'Title'], rows: rows.map((row) => [row.publicId, row.severity, row.normalValue, row.observedValue, row.title]) } : undefined,
    resultCount: rows.length,
  }
}

async function settlements(): Promise<ToolResult> {
  const [summary, delayed, queued, latestBatch] = await Promise.all([
    reconciliationSummary(),
    prisma.transaction.aggregate({ where: { settlementStatus: 'DELAYED' }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.transaction.count({ where: { status: 'SUCCESS', settlementStatus: 'QUEUED' } }),
    prisma.settlement.findFirst({ orderBy: { createdAt: 'desc' }, include: { institution: true } }),
  ])
  if (!summary.latest && !latestBatch) return { tool: 'settlements', status: 'NO_DATA', summary: `${NO_DATA} No settlement batches or reconciliation runs exist yet.`, evidence: [], nextSteps: ['Run the EOD Settlement and Transaction Reconciliation jobs.'], actions: [{ label: 'Operational jobs', href: '/jobs' }] }
  const run = summary.latest
  return {
    tool: 'settlements',
    status: 'ANSWERED',
    summary: delayed._count._all ? `${delayed._count._all} payments (${formatNpr(Number(delayed._sum.amount ?? 0))}) have delayed settlement.` : 'No payments are currently in delayed settlement.',
    evidence: [
      `${queued.toLocaleString('en-US')} successful payments are queued for the next settlement cycle.`,
      latestBatch ? `Latest batch ${latestBatch.publicId} for ${latestBatch.institution.name}: ${latestBatch.status}, ${latestBatch.transactionCount} payments, ${formatNpr(Number(latestBatch.amount))}.` : '',
      run ? `Latest reconciliation ${run.id} (${run.status}): ${run.matchedCount}/${run.expectedCount} matched, ${run.unmatchedCount} unmatched, ledger difference ${formatNpr(run.difference)}.` : 'No reconciliation run yet.',
      `${summary.openRuns} reconciliation run${summary.openRuns === 1 ? '' : 's'} need attention.`,
    ].filter(Boolean),
    nextSteps: delayed._count._all ? ['Run the EOD Settlement job once the settlement service is healthy.', 'Re-run reconciliation for today.'] : ['No action needed.'],
    actions: [{ label: 'Open reconciliation', href: run ? `/reconciliation?run=${run.id}` : '/reconciliation' }, { label: 'Operational jobs', href: '/jobs' }],
  }
}

async function jobs(): Promise<ToolResult> {
  const rows = await prisma.operationalJob.findMany({ orderBy: { createdAt: 'desc' }, take: 8 })
  if (!rows.length) return { tool: 'jobs', status: 'NO_DATA', summary: `${NO_DATA} No operational jobs have run yet.`, evidence: [], nextSteps: ['Trigger a job from the Operational Jobs page.'], actions: [{ label: 'Operational jobs', href: '/jobs' }] }
  const failed = rows.filter((row) => row.status === 'FAILED')
  return {
    tool: 'jobs',
    status: 'ANSWERED',
    summary: failed.length ? `${failed.length} of the last ${rows.length} job runs failed.` : `The last ${rows.length} job runs completed without failures.`,
    evidence: rows.map((row) => `${row.publicId} ${row.type} ${row.status}: ${row.recordsProcessed} processed, ${row.failedRecords} failed${row.error ? ` — ${row.error}` : ''}.`),
    nextSteps: failed.length ? ['Open the failed job and re-run it after fixing the cause.'] : ['No action needed.'],
    actions: [{ label: 'Operational jobs', href: '/jobs' }],
    table: { columns: ['Job', 'Type', 'Status', 'Processed', 'Failed'], rows: rows.map((row) => [row.publicId, row.type, row.status, row.recordsProcessed, row.failedRecords]) },
    resultCount: rows.length,
  }
}

async function dataQuality(): Promise<ToolResult> {
  const data = await dataQualityOverview()
  if (!data.lastCheckedAt) return { tool: 'dataQuality', status: 'NO_DATA', summary: `${NO_DATA} The data quality scan has not run yet.`, evidence: [], nextSteps: ['Run the Data Validation job.'], actions: [{ label: 'Operational jobs', href: '/jobs' }] }
  const open = data.issues.filter((issue) => issue.status !== 'RESOLVED' && issue.affectedCount > 0)
  return {
    tool: 'dataQuality',
    status: 'ANSWERED',
    summary: `${open.length} open data quality issue${open.length === 1 ? '' : 's'} across ${data.totalRecords.toLocaleString('en-US')} records. Completeness ${data.metrics.completeness.toFixed(2)}%, accuracy ${data.metrics.accuracy.toFixed(2)}%.`,
    evidence: open.map((issue) => `${issue.title}: ${issue.affectedCount} records (${issue.status}).`),
    nextSteps: open.length ? ['Open the largest issue and review the affected records.'] : ['No action needed.'],
    actions: open.slice(0, 3).map((issue) => ({ label: issue.title, href: `/data-quality?issue=${issue.id}` })).concat([{ label: 'Data quality', href: '/data-quality' }]),
    resultCount: open.length,
  }
}

async function apiMetrics(): Promise<ToolResult> {
  const { items } = await listEndpoints(15)
  const active = items.filter((row) => row.calls > 0)
  if (!active.length) return { tool: 'apiMetrics', status: 'NO_DATA', summary: `${NO_DATA} No API calls were recorded in the last 15 minutes.`, evidence: [], nextSteps: ['Start the demo simulator to generate API traffic.'], actions: [{ label: 'Open Demo Simulator', href: '/demo-simulator' }] }
  const slowest = [...active].sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0))[0]
  const worstErrors = [...active].sort((a, b) => (b.errorRate ?? 0) - (a.errorRate ?? 0))[0]
  return {
    tool: 'apiMetrics',
    status: 'ANSWERED',
    summary: `${slowest.key} is the slowest API (P95 ${formatDuration(slowest.p95Ms ?? 0)}); ${worstErrors.key} has the highest 5xx rate at ${formatPercent(worstErrors.errorRate ?? 0)}.`,
    evidence: active.map((row) => `${row.key}: ${row.rpm}/min, P50 ${formatDuration(row.p50Ms ?? 0)}, P95 ${formatDuration(row.p95Ms ?? 0)}, ${formatPercent(row.errorRate ?? 0)} errors, ${formatPercent(row.availability ?? 0)} available.`),
    nextSteps: ['Open the slowest endpoint to see its latency trend and failing calls.'],
    actions: [{ label: slowest.key, href: `/system-health/apis/${slowest.id}` }, { label: 'System Health', href: '/system-health' }],
    table: { columns: ['Endpoint', 'RPM', 'P95 (ms)', 'Error %', 'Availability %'], rows: active.map((row) => [row.key, row.rpm, row.p95Ms, Number((row.errorRate ?? 0).toFixed(2)), Number((row.availability ?? 0).toFixed(2))]) },
    resultCount: active.length,
  }
}

async function systemHealthTool(): Promise<ToolResult> {
  const services = await prisma.service.findMany({ orderBy: { name: 'asc' } })
  const unhealthy = services.filter((service) => service.status !== 'OPERATIONAL')
  return {
    tool: 'systemHealth',
    status: 'ANSWERED',
    summary: unhealthy.length ? `${unhealthy.length} of ${services.length} services are not fully operational: ${unhealthy.map((service) => `${service.name} (${service.status.toLowerCase()})`).join(', ')}.` : `All ${services.length} demo services are operational.`,
    evidence: services.map((service) => `${service.name}: ${service.status}, ${service.responseTimeMs}ms, ${service.errorRate.toFixed(2)}% errors.`),
    nextSteps: unhealthy.length ? ['Open the service map to see which callers depend on the degraded service.'] : ['No action needed.'],
    actions: [{ label: 'Service map', href: unhealthy[0] ? `/service-map?focus=${unhealthy[0].key}` : '/service-map' }, { label: 'System Health', href: '/system-health' }],
  }
}

async function institutions(question: string): Promise<ToolResult> {
  const range = resolveRange({ range: parseRange(question.toLowerCase()) })
  const rows = (await institutionPerformance(range)).filter((row) => row.transactions > 0)
  if (!rows.length) return { tool: 'institutions', status: 'NO_DATA', summary: `${NO_DATA} No institution activity in ${windowLabel(range)}.`, evidence: [], nextSteps: ['Pick a wider time range.'], actions: [] }
  const byFailure = [...rows].sort((a, b) => b.failureRate - a.failureRate)
  const slowest = [...rows].sort((a, b) => b.avgResponseMs - a.avgResponseMs)[0]
  const worst = byFailure[0]
  return {
    tool: 'institutions',
    status: 'ANSWERED',
    summary: `${worst.name} has the highest failure rate in ${windowLabel(range)} at ${formatPercent(worst.failureRate)}; ${slowest.name} is slowest at ${formatDuration(slowest.avgResponseMs)}.`,
    evidence: byFailure.map((row) => `${row.name}: ${row.transactions.toLocaleString('en-US')} tx, ${formatPercent(row.failureRate)} failed, ${formatDuration(row.avgResponseMs)} average.`),
    nextSteps: [`Open ${worst.name} to see its failure reasons.`],
    actions: [{ label: worst.name, href: `/institutions/${worst.id}` }, { label: `Failed at ${worst.name}`, href: `/transactions?status=FAILED&institution=${worst.code}` }],
    table: { columns: ['Institution', 'Transactions', 'Failure %', 'Avg response (ms)', 'Value (NPR)'], rows: byFailure.map((row) => [row.name, row.transactions, Number(row.failureRate.toFixed(2)), Math.round(row.avgResponseMs), Math.round(row.value)]) },
    resultCount: rows.length,
  }
}

async function busiestHour(question: string): Promise<ToolResult> {
  const range = resolveRange({ range: parseRange(question.toLowerCase()) })
  const rows = await prisma.$queryRaw<Array<{ hour: Date; count: number }>>(Prisma.sql`
    SELECT date_trunc('hour', "createdAt") AS hour, COUNT(*)::int AS count FROM "Transaction"
    WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to} GROUP BY 1 ORDER BY count DESC LIMIT 5`)
  if (!rows.length) return { tool: 'busiestHour', status: 'NO_DATA', summary: `${NO_DATA} No transactions in ${windowLabel(range)}.`, evidence: [], nextSteps: [], actions: [] }
  const fmt = (date: Date) => date.toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
  return {
    tool: 'busiestHour',
    status: 'ANSWERED',
    summary: `The busiest hour in ${windowLabel(range)} started at ${fmt(rows[0].hour)} (Asia/Kathmandu) with ${rows[0].count.toLocaleString('en-US')} transactions.`,
    evidence: rows.map((row) => `${fmt(row.hour)}: ${row.count.toLocaleString('en-US')}`),
    nextSteps: ['Check whether the peak overlaps an incident.'],
    actions: [{ label: 'Open analytics', href: '/analytics' }],
    resultCount: rows.length,
  }
}

async function paymentMethods(question: string): Promise<ToolResult> {
  const range = resolveRange({ range: parseRange(question.toLowerCase()) })
  const rows = await prisma.$queryRaw<Array<{ method: string; total: number; failed: number }>>(Prisma.sql`
    SELECT "paymentMethod"::text AS method, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
    FROM "Transaction" WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to} GROUP BY 1`)
  if (!rows.length) return { tool: 'paymentMethods', status: 'NO_DATA', summary: `${NO_DATA} No transactions in ${windowLabel(range)}.`, evidence: [], nextSteps: [], actions: [] }
  const ranked = rows.map((row) => ({ ...row, rate: row.total ? (row.failed / row.total) * 100 : 0 })).sort((a, b) => b.rate - a.rate)
  return {
    tool: 'paymentMethods',
    status: 'ANSWERED',
    summary: `${ranked[0].method} has the highest failure rate in ${windowLabel(range)} at ${formatPercent(ranked[0].rate)}.`,
    evidence: ranked.map((row) => `${row.method}: ${formatPercent(row.rate)} (${row.failed}/${row.total})`),
    nextSteps: [`Filter failed ${ranked[0].method} transactions to see the reasons.`],
    actions: [{ label: `Failed ${ranked[0].method} payments`, href: `/transactions?status=FAILED&paymentMethod=${ranked[0].method}` }],
    resultCount: ranked.length,
  }
}

async function generateReportTool(question: string, userId?: string): Promise<ToolResult> {
  const range = resolveRange({ range: parseRange(question.toLowerCase()) === '24h' ? 'today' : parseRange(question.toLowerCase()) })
  const { generateReport } = await import('../reportService.js')
  const report = await generateReport({ type: 'DAILY_OPERATIONS', from: range.from.toISOString(), to: range.to.toISOString(), userId, source: 'ai' })
  return {
    tool: 'generateReport',
    status: 'ANSWERED',
    summary: `Created ${report.title}.`,
    evidence: [`The report snapshot was built from the same aggregates as the dashboard for ${windowLabel(range)}.`],
    nextSteps: ['Open the report to view charts or download the PDF/CSV.'],
    actions: [{ label: 'Open report', href: `/reports/${report.id}` }],
    reportId: report.id,
  }
}

async function dataQuery(question: string, role: Role): Promise<ToolResult> {
  const parsed = parseQuestion(question)
  if (!parsed.ok) {
    return { tool: 'dataQuery', status: 'NO_DATA', summary: parsed.message, evidence: [], nextSteps: ['Try: "failed transactions at Demo Bank B today", "failure rate by bank this week", or "slowest API".'], actions: [{ label: 'Ask Your Data', href: '/ask-data' }] }
  }
  const result = await executeQuery(parsed.query, role, { maxRows: 20 })
  return {
    tool: 'dataQuery',
    status: result.total ? 'ANSWERED' : 'NO_DATA',
    summary: result.total ? result.summary : `${NO_DATA} ${result.summary}`,
    evidence: parsed.interpretation,
    nextSteps: result.total ? ['Open the query in Ask Your Data to refine filters or export CSV.'] : ['Widen the time range or remove a filter.'],
    actions: [...result.actions, { label: 'Open in Ask Your Data', href: `/ask-data?q=${encodeURIComponent(question)}` }],
    table: result.rows.length ? { columns: result.columns, rows: result.rows } : undefined,
    structuredQuery: parsed.query,
    resultCount: result.total,
  }
}

export async function runTool(tool: ToolName, question: string, user: { id?: string; role: Role }): Promise<ToolResult> {
  const allowed = TOOL_PERMISSION[tool].some((permission) => can(user.role, permission))
  if (!allowed) {
    return { tool, status: 'FORBIDDEN', summary: 'Your role does not have access to the data needed for that question.', evidence: [], nextSteps: ['Ask an administrator if you need this access.'], actions: [] }
  }
  switch (tool) {
    case 'overview': return overview(question)
    case 'explainChange': return explainChange(question)
    case 'incidentDetail': return incidentDetail(question)
    case 'activeIncidents': return activeIncidents()
    case 'anomalies': return anomalies()
    case 'settlements': return settlements()
    case 'jobs': return jobs()
    case 'dataQuality': return dataQuality()
    case 'apiMetrics': return apiMetrics()
    case 'systemHealth': return systemHealthTool()
    case 'institutions': return institutions(question)
    case 'busiestHour': return busiestHour(question)
    case 'paymentMethods': return paymentMethods(question)
    case 'generateReport': return generateReportTool(question, user.id)
    case 'dataQuery': return dataQuery(question, user.role)
  }
}

function render(result: ToolResult) {
  const lines = [`Summary: ${result.summary}`]
  if (result.evidence.length) lines.push('', 'Evidence:', ...result.evidence.map((line) => `- ${line}`))
  if (result.explanation) lines.push('', result.explanation)
  if (result.nextSteps.length) lines.push('', 'Recommended next steps:', ...result.nextSteps.map((step, index) => `${index + 1}. ${step}`))
  lines.push('', `Limitation: ${LIMITATION}`)
  return lines.join('\n')
}

export async function answerQuestion(question: string, user: { id?: string; role: Role }) {
  const started = Date.now()
  const parsed = parseQuestion(question)
  let result: ToolResult
  let status: string
  if (!parsed.ok && parsed.reason === 'refused') {
    result = { tool: 'dataQuery', status: 'FORBIDDEN', summary: parsed.message, evidence: [], nextSteps: [], actions: [] }
    status = 'REFUSED'
  } else {
    const tool = routeIntent(question)
    try {
      result = await runTool(tool, question, user)
      status = result.status
    } catch (error) {
      const forbiddenError = error instanceof Error && 'status' in error && (error as { status: number }).status === 403
      result = { tool, status: forbiddenError ? 'FORBIDDEN' : 'NO_DATA', summary: forbiddenError ? 'Your role does not have access to the data needed for that question.' : NO_DATA, evidence: [], nextSteps: [], actions: [] }
      status = forbiddenError ? 'FORBIDDEN' : 'ERROR'
    }
  }
  let content = render(result)
  let provider: 'mock' | 'openai' = 'mock'
  if (env.aiEnabled && result.status === 'ANSWERED') {
    try {
      content = await rewriteWithProvider(question, result)
      provider = 'openai'
    } catch {
      provider = 'mock'
    }
  }
  await prisma.aiQuery.create({
    data: {
      userId: user.id,
      kind: 'assistant',
      question: question.slice(0, 2000),
      intent: result.tool,
      structuredQuery: result.structuredQuery as Prisma.InputJsonValue | undefined,
      resultCount: result.resultCount ?? null,
      status,
      durationMs: Date.now() - started,
    },
  }).catch(() => undefined)
  return {
    provider,
    notice: provider === 'mock' ? 'Answers are generated by the local FinOpsX analysis engine from live demo data.' : null,
    content,
    tool: result.tool,
    status: result.status,
    table: result.table ?? null,
    actions: result.actions,
    reportId: result.reportId ?? null,
  }
}

async function rewriteWithProvider(question: string, result: ToolResult) {
  const response = await fetch(`${env.aiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.aiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.aiModel,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: "You are the FinOpsX demo operations assistant. Rewrite the JSON tool result as a concise answer. Use only numbers present in the JSON. Never invent metrics, transactions, or causes. Use 'Likely cause' wording for hypotheses. If data is missing say \"I don't have enough data to answer that.\" End with the limitation line.",
        },
        { role: 'user', content: JSON.stringify({ question, result: { ...result, limitation: LIMITATION } }) },
      ],
    }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!response.ok) throw new Error('AI provider request failed')
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  const text = body.choices?.[0]?.message?.content
  if (!text) throw new Error('Empty AI response')
  return text
}
