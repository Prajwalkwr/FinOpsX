import { Prisma, type AnomalyType } from '@prisma/client'
import type { AiAction } from '@finopsx/shared'
import { prisma } from '../lib/prisma.js'
import { pearson } from '../utils/stats.js'
import { formatMs } from './anomalyService.js'

type Evidence = { label: string; value: string; source: string; supports: boolean }

/** Only these anomaly kinds can plausibly share a cause with an incident of each type; time overlap alone is not enough. */
export const RELATED_ANOMALY_TYPES: Record<string, AnomalyType[]> = {
  LATENCY: ['API_LATENCY_SPIKE', 'FAILURE_RATE_SPIKE', 'REPEATED_FAILURE'],
  FAILURE_SPIKE: ['FAILURE_RATE_SPIKE', 'REPEATED_FAILURE', 'API_LATENCY_SPIKE'],
  AVAILABILITY: ['FAILURE_RATE_SPIKE', 'API_LATENCY_SPIKE', 'REPEATED_FAILURE'],
  NOTIFICATION: ['API_LATENCY_SPIKE', 'FAILURE_RATE_SPIKE'],
  SETTLEMENT: ['SETTLEMENT_DELAY'],
  VOLUME: ['TRANSACTION_VOLUME_SPIKE', 'INSTITUTION_ACTIVITY', 'UNUSUAL_TIME_ACTIVITY'],
  MERCHANT: ['MERCHANT_VOLUME_SPIKE', 'HIGH_VALUE_SPIKE'],
}

export type RcaResult = {
  likelyCause: string | null
  confirmed: boolean
  confidence: number
  confidenceLabel: 'Low' | 'Medium' | 'High'
  evidence: Evidence[]
  affectedServices: string[]
  affectedInstitutions: string[]
  impactedDependents: Array<{ name: string; status: string }>
  upstreamDependencies: Array<{ name: string; status: string }>
  correlatedAnomalies: Array<{ id: string; title: string }>
  recentChanges: Array<{ action: string; actor: string; at: string; detail: string | null }>
  recommendedActions: string[]
  actions: AiAction[]
  limitations: string
  window: { from: string; to: string; baselineFrom: string; baselineTo: string }
  generatedAt: string
}

type WindowStats = { total: number; failed: number; latency: number }

async function txWindow(from: Date, to: Date, institutionIds: string[]): Promise<WindowStats> {
  const filter = institutionIds.length ? Prisma.sql`AND "institutionId" IN (${Prisma.join(institutionIds)})` : Prisma.empty
  const [row] = await prisma.$queryRaw<WindowStats[]>(Prisma.sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed, COALESCE(AVG("responseTimeMs"), 0)::float AS latency
    FROM "Transaction" WHERE "createdAt" >= ${from} AND "createdAt" < ${to} ${filter}`)
  return row ?? { total: 0, failed: 0, latency: 0 }
}

type EndpointStats = { id: string; key: string; total: number; errors: number; p95: number }

async function endpointWindow(from: Date, to: Date, serviceIds: string[]): Promise<EndpointStats[]> {
  if (!serviceIds.length) return []
  return prisma.$queryRaw<EndpointStats[]>(Prisma.sql`
    SELECT e.id, e.method || ' ' || e.endpoint AS key, COUNT(c.id)::int AS total,
      COUNT(c.id) FILTER (WHERE c."statusCode" >= 500)::int AS errors,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY c."latencyMs"), 0)::float AS p95
    FROM "ApiMetric" e JOIN "ApiCall" c ON c."endpointId" = e.id
    WHERE e."serviceId" IN (${Prisma.join(serviceIds)}) AND c."createdAt" >= ${from} AND c."createdAt" < ${to}
    GROUP BY e.id, e.method, e.endpoint`)
}

const pct = (part: number, total: number) => (total ? (part / total) * 100 : 0)

/** Builds an evidence-based root cause hypothesis for an incident from stored metrics only. */
export async function analyzeIncident(incidentId: string): Promise<RcaResult> {
  const incident = await prisma.incident.findUniqueOrThrow({
    where: { id: incidentId },
    include: {
      services: { include: { service: { include: { dependsOn: { include: { toService: true } }, dependents: { include: { fromService: true } } } } } },
      institutions: { include: { institution: true } },
      anomalies: true,
    },
  })
  const end = incident.resolvedAt ?? new Date()
  const from = new Date(Math.max(incident.detectedAt.getTime() - 10 * 60_000, end.getTime() - 15 * 60_000))
  const baselineTo = new Date(incident.detectedAt.getTime() - 10 * 60_000)
  const baselineFrom = new Date(baselineTo.getTime() - 60 * 60_000)
  const institutionIds = incident.institutions.map((row) => row.institutionId)
  const serviceIds = incident.services.map((row) => row.serviceId)
  const institutionNames = incident.institutions.map((row) => row.institution.name)
  const scope = institutionNames.length ? institutionNames.join(', ') : 'all institutions'

  const [current, baseline, currentEndpoints, baselineEndpoints, reasons, delayed, changes, anomalies] = await Promise.all([
    txWindow(from, end, institutionIds),
    txWindow(baselineFrom, baselineTo, institutionIds),
    endpointWindow(from, end, serviceIds),
    endpointWindow(baselineFrom, baselineTo, serviceIds),
    prisma.transaction.groupBy({
      by: ['failureReason'],
      where: { status: 'FAILED', createdAt: { gte: from, lt: end }, ...(institutionIds.length ? { institutionId: { in: institutionIds } } : {}) },
      _count: { _all: true },
      orderBy: { _count: { failureReason: 'desc' } },
    }),
    prisma.transaction.count({ where: { settlementStatus: 'DELAYED', updatedAt: { gte: from, lt: end } } }),
    prisma.auditLog.findMany({
      where: { resource: { in: ['SIMULATOR', 'THRESHOLD_CONFIG', 'SETTINGS'] }, createdAt: { gte: new Date(incident.detectedAt.getTime() - 60 * 60_000), lte: new Date(incident.detectedAt.getTime() + 5 * 60_000) } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.anomaly.findMany({
      where: {
        ...(RELATED_ANOMALY_TYPES[incident.incidentType] ? { type: { in: RELATED_ANOMALY_TYPES[incident.incidentType] } } : {}),
        OR: [
          { incidentId: incident.id },
          { detectedAt: { gte: new Date(incident.detectedAt.getTime() - 15 * 60_000), lte: new Date(end.getTime() + 60_000) }, ...(institutionIds.length ? { institutionId: { in: institutionIds } } : {}) },
        ],
      },
      orderBy: { detectedAt: 'desc' },
      take: 6,
    }),
  ])

  const evidence: Evidence[] = []
  const currentFailure = pct(current.failed, current.total)
  const baselineFailure = pct(baseline.failed, baseline.total)
  const latencyRatio = baseline.latency > 0 ? current.latency / baseline.latency : 0
  const failureRatio = baselineFailure > 0 ? currentFailure / baselineFailure : currentFailure > 0 ? 99 : 0
  const totalFailed = reasons.reduce((sum, row) => sum + row._count._all, 0)
  const topReason = reasons[0]
  const topReasonShare = topReason ? pct(topReason._count._all, totalFailed) : 0
  const topReasonName = topReason?.failureReason ? String(topReason.failureReason).replace(/_/g, ' ').toLowerCase() : null

  if (current.total > 0) {
    evidence.push({
      label: `Average response time (${scope})`,
      value: baseline.total ? `${formatMs(baseline.latency)} → ${formatMs(current.latency)} (${latencyRatio.toFixed(1)}×)` : formatMs(current.latency),
      source: 'Transaction.responseTimeMs',
      supports: latencyRatio >= 1.8,
    })
    evidence.push({
      label: `Failure rate (${scope})`,
      value: baseline.total ? `${baselineFailure.toFixed(1)}% → ${currentFailure.toFixed(1)}% (${current.failed} of ${current.total})` : `${currentFailure.toFixed(1)}%`,
      source: 'Transaction.status',
      supports: failureRatio >= 2 && currentFailure >= 5,
    })
  }
  if (topReason && totalFailed >= 5) {
    evidence.push({ label: 'Dominant failure reason', value: `${topReasonName} (${topReasonShare.toFixed(0)}% of ${totalFailed} failures)`, source: 'Transaction.failureReason', supports: topReasonShare >= 50 })
  }
  for (const endpoint of currentEndpoints) {
    const before = baselineEndpoints.find((row) => row.id === endpoint.id)
    const errorRate = pct(endpoint.errors, endpoint.total)
    const beforeRate = before ? pct(before.errors, before.total) : 0
    const p95Ratio = before && before.p95 > 0 ? endpoint.p95 / before.p95 : 0
    if (endpoint.total < 5) continue
    if (p95Ratio >= 1.8 || errorRate >= 5) {
      evidence.push({
        label: `${endpoint.key} P95 / 5xx rate`,
        value: `${before ? formatMs(before.p95) : 'n/a'} → ${formatMs(endpoint.p95)}; ${beforeRate.toFixed(1)}% → ${errorRate.toFixed(1)}%`,
        source: 'ApiCall',
        supports: true,
      })
    }
  }
  if (delayed > 0) evidence.push({ label: 'Settlement-delayed payments in window', value: String(delayed), source: 'Transaction.settlementStatus', supports: delayed >= 10 })

  const series = await prisma.$queryRaw<Array<{ latency: number; rate: number }>>(Prisma.sql`
    SELECT AVG("responseTimeMs")::float AS latency, (COUNT(*) FILTER (WHERE status = 'FAILED')::float / COUNT(*)) * 100 AS rate
    FROM "Transaction" WHERE "createdAt" >= ${baselineFrom} AND "createdAt" < ${end}
    ${institutionIds.length ? Prisma.sql`AND "institutionId" IN (${Prisma.join(institutionIds)})` : Prisma.empty}
    GROUP BY date_trunc('minute', "createdAt") HAVING COUNT(*) >= 3 ORDER BY date_trunc('minute', "createdAt")`)
  const correlation = pearson(series.map((row) => row.latency), series.map((row) => row.rate))
  if (series.length >= 8 && Math.abs(correlation) >= 0.5) {
    evidence.push({ label: 'Latency vs failure-rate correlation (per minute)', value: `r = ${correlation.toFixed(2)} over ${series.length} minutes`, source: 'Transaction (derived)', supports: correlation >= 0.6 })
  }
  for (const anomaly of anomalies) {
    evidence.push({ label: `Anomaly ${anomaly.publicId}`, value: anomaly.title, source: 'Anomaly', supports: true })
  }
  const recentChanges = changes.map((row) => ({ action: row.action, actor: row.actorEmail, at: row.createdAt.toISOString(), detail: row.newValue ? JSON.stringify(row.newValue).slice(0, 160) : null }))
  const seenActions = new Set<string>()
  for (const change of recentChanges) {
    if (seenActions.has(change.action) || seenActions.size >= 2) continue
    seenActions.add(change.action)
    const minutes = Math.round((incident.detectedAt.getTime() - new Date(change.at).getTime()) / 60_000)
    const when = minutes > 0 ? `${minutes} min before detection` : minutes < 0 ? `${-minutes} min after detection` : 'at detection'
    evidence.push({ label: 'Recent configuration change', value: `${change.action} by ${change.actor}, ${when}`, source: 'AuditLog', supports: change.action.includes('SCENARIO') })
  }

  let hotspot: { id: string; code: string; name: string; failureShare: number; latencyFrom: number; latencyTo: number } | null = null
  if (!institutionIds.length && current.total >= 20) {
    const byInstitution = await prisma.$queryRaw<Array<{ id: string; code: string; name: string; total: number; failed: number; latency: number; baseLatency: number | null }>>(Prisma.sql`
      SELECT i.id, i.code, i.name,
        COUNT(t.id) FILTER (WHERE t."createdAt" >= ${from})::int AS total,
        COUNT(t.id) FILTER (WHERE t."createdAt" >= ${from} AND t.status = 'FAILED')::int AS failed,
        COALESCE(AVG(t."responseTimeMs") FILTER (WHERE t."createdAt" >= ${from}), 0)::float AS latency,
        AVG(t."responseTimeMs") FILTER (WHERE t."createdAt" < ${baselineTo})::float AS "baseLatency"
      FROM "Institution" i JOIN "Transaction" t ON t."institutionId" = i.id AND t."createdAt" >= ${baselineFrom} AND t."createdAt" < ${end}
      GROUP BY i.id`)
    const failedTotal = byInstitution.reduce((sum, row) => sum + row.failed, 0)
    const ranked = byInstitution
      .filter((row) => row.total >= 5)
      .map((row) => ({ ...row, share: failedTotal ? row.failed / failedTotal : 0, ratio: row.baseLatency ? row.latency / row.baseLatency : 0 }))
      .sort((a, b) => b.share - a.share || b.ratio - a.ratio)
    const top = ranked[0]
    const othersRatio = ranked.slice(1).reduce((max, row) => Math.max(max, row.ratio), 0)
    if (top && ((failedTotal >= 5 && top.share >= 0.6) || (top.ratio >= 2 && top.ratio >= othersRatio * 1.8))) {
      hotspot = { id: top.id, code: top.code, name: top.name, failureShare: top.share * 100, latencyFrom: top.baseLatency ?? 0, latencyTo: top.latency }
      evidence.push({
        label: `Concentration at ${top.name}`,
        value: `${(top.share * 100).toFixed(0)}% of failures; response time ${formatMs(top.baseLatency ?? 0)} → ${formatMs(top.latency)}`,
        source: 'Transaction (by institution)',
        supports: true,
      })
    }
  }

  const services = incident.services.map((row) => row.service)
  const impactedDependents = services.flatMap((service) => service.dependents.map((dep) => ({ name: dep.fromService.name, status: dep.fromService.status })))
  const upstreamDependencies = services.flatMap((service) => service.dependsOn.map((dep) => ({ name: dep.toService.name, status: dep.toService.status })))
  const degradedUpstream = upstreamDependencies.filter((dep) => dep.status !== 'OPERATIONAL')
  if (degradedUpstream.length) {
    evidence.push({ label: 'Degraded dependencies', value: degradedUpstream.map((dep) => `${dep.name} (${dep.status.toLowerCase()})`).join(', '), source: 'Service map', supports: true })
  }

  const serviceName = services[0]?.name ?? 'the affected service'
  const notify = currentEndpoints.find((row) => row.key === 'POST /notify')
  const settlementEndpoint = currentEndpoints.find((row) => row.key === 'POST /settlement')
  let likelyCause: string | null = null
  const recommended: string[] = []
  switch (incident.incidentType) {
    case 'LATENCY':
    case 'AVAILABILITY':
      if (latencyRatio >= 1.8) {
        likelyCause = `${scope} API responses slowed from ${formatMs(baseline.latency)} to ${formatMs(current.latency)}${topReason?.failureReason === 'TIMEOUT' ? '; requests over the 8s limit are failing with TIMEOUT (response code 68)' : ''}.`
        recommended.push(`Check ${scope} connectivity and the ${serviceName} connection pool.`, 'Consider routing new payments to healthy institutions until latency recovers.', 'Watch P95 on POST /bank/authorize for recovery.')
      } else if (currentEndpoints.some((row) => pct(row.errors, row.total) >= 5)) {
        const worst = [...currentEndpoints].sort((a, b) => pct(b.errors, b.total) - pct(a.errors, a.total))[0]
        likelyCause = `${worst.key} is returning server errors (${pct(worst.errors, worst.total).toFixed(1)}% 5xx), which is lowering ${serviceName} availability.`
        recommended.push(`Inspect ${worst.key} error responses.`, `Check upstream dependencies of ${serviceName}.`)
      }
      break
    case 'FAILURE_SPIKE':
      if (currentFailure >= 5 && topReasonName) {
        likelyCause = `Payments are failing with "${topReasonName}" (${topReasonShare.toFixed(0)}% of failures) — failure rate rose from ${baselineFailure.toFixed(1)}% to ${currentFailure.toFixed(1)}% across ${scope}.`
        recommended.push(`Review failed transactions with reason "${topReasonName}".`, 'Check the Bank API integration path shared by the affected institutions.', 'Notify affected institutions if the error persists.')
      }
      break
    case 'SETTLEMENT':
      if (delayed > 0) {
        likelyCause = `Settlement batches are not being confirmed within the settlement window; ${delayed} successful payments are waiting${settlementEndpoint ? ` and POST /settlement P95 is ${formatMs(settlementEndpoint.p95)}` : ''}.`
        recommended.push('Run the Settlement Validation job to confirm batch totals.', 'Run the EOD Settlement job once the Settlement Service recovers.', 'Run reconciliation for today to confirm no records are missing.')
      }
      break
    case 'NOTIFICATION':
      if (notify && notify.total > 0) {
        likelyCause = `Notification Service is degraded — POST /notify is failing ${pct(notify.errors, notify.total).toFixed(1)}% of calls with P95 ${formatMs(notify.p95)}. Payments still complete, but confirmations are not delivered.`
        recommended.push('Retry failed notifications after the Notification Service recovers.', 'Check the notification provider queue depth.')
      }
      break
    case 'VOLUME':
      if (baseline.total > 0) {
        const ratio = (current.total / Math.max(1, (end.getTime() - from.getTime()) / 60_000)) / (baseline.total / 60)
        likelyCause = `Transaction volume is ${ratio.toFixed(1)}× the previous hour's rate, and average response time moved from ${formatMs(baseline.latency)} to ${formatMs(current.latency)}.`
        recommended.push('Confirm whether the traffic is expected (campaign or batch).', 'Check Payment Gateway capacity and queue length on System Health.')
      }
      break
    case 'MERCHANT': {
      const top = await prisma.transaction.groupBy({ by: ['merchantId'], where: { createdAt: { gte: from, lt: end } }, _count: { _all: true }, orderBy: { _count: { merchantId: 'desc' } }, take: 1 })
      if (top[0] && current.total > 0) {
        const merchant = await prisma.merchant.findUnique({ where: { id: top[0].merchantId } })
        likelyCause = `${merchant?.name ?? 'One merchant'} generated ${pct(top[0]._count._all, current.total).toFixed(0)}% of payments in the window, well above its usual share.`
        recommended.push(`Review recent payments for ${merchant?.name ?? 'the merchant'}.`, 'Confirm with the merchant whether a campaign is running.')
      }
      break
    }
    default:
      if (latencyRatio >= 1.8) likelyCause = `Response times across ${scope} rose ${latencyRatio.toFixed(1)}× against the baseline.`
      else if (failureRatio >= 2 && currentFailure >= 5) likelyCause = `Failure rate across ${scope} rose from ${baselineFailure.toFixed(1)}% to ${currentFailure.toFixed(1)}%.`
  }
  if (hotspot && likelyCause) {
    likelyCause += ` The impact is concentrated at ${hotspot.name} (${hotspot.failureShare.toFixed(0)}% of failures, response time ${formatMs(hotspot.latencyFrom)} → ${formatMs(hotspot.latencyTo)}).`
    recommended.unshift(`Check ${hotspot.name} connectivity and bank API response times first.`)
  }
  if (degradedUpstream.length && likelyCause) likelyCause += ` Upstream dependency status: ${degradedUpstream.map((dep) => dep.name).join(', ')} degraded.`

  const supporting = evidence.filter((item) => item.supports).length
  const confidence = likelyCause ? Math.min(0.92, 0.35 + supporting * 0.11) : 0
  const confidenceLabel = confidence >= 0.75 ? 'High' : confidence >= 0.5 ? 'Medium' : 'Low'
  const actions: AiAction[] = []
  if (incident.institutions[0]) actions.push({ label: `Failed transactions at ${incident.institutions[0].institution.name}`, href: `/transactions?status=FAILED&institution=${incident.institutions[0].institution.code}` })
  else if (hotspot) actions.push({ label: `Failed transactions at ${hotspot.name}`, href: `/transactions?status=FAILED&institution=${hotspot.code}` }, { label: `Open ${hotspot.name}`, href: `/institutions/${hotspot.id}` })
  if (currentEndpoints[0]) actions.push({ label: `Open ${currentEndpoints[0].key}`, href: `/system-health/apis/${currentEndpoints[0].id}` })
  if (services[0]) actions.push({ label: 'Open service map', href: `/service-map?focus=${services[0].key}` })
  if (incident.incidentType === 'SETTLEMENT') actions.push({ label: 'Operational jobs', href: '/jobs' })
  for (const anomaly of anomalies.slice(0, 2)) actions.push({ label: `Anomaly ${anomaly.publicId}`, href: `/anomalies?focus=${anomaly.publicId}` })

  return {
    likelyCause,
    confirmed: incident.rootCauseConfirmed,
    confidence: Number(confidence.toFixed(2)),
    confidenceLabel,
    evidence,
    affectedServices: services.map((service) => service.name),
    affectedInstitutions: institutionNames.length ? institutionNames : hotspot ? [hotspot.name] : [],
    impactedDependents,
    upstreamDependencies,
    correlatedAnomalies: anomalies.map((row) => ({ id: row.publicId, title: row.title })),
    recentChanges,
    recommendedActions: likelyCause ? recommended : ['Collect more data: keep the incident open while metrics accumulate.'],
    actions,
    limitations: 'AI-generated analysis from synthetic demo metrics. Correlation is not proof of causation — verify before taking operational action.',
    window: { from: from.toISOString(), to: end.toISOString(), baselineFrom: baselineFrom.toISOString(), baselineTo: baselineTo.toISOString() },
    generatedAt: new Date().toISOString(),
  }
}

export function summarizeRca(title: string, rca: RcaResult, confirmedRootCause?: string | null) {
  const lines = [`Summary: ${title}.`]
  if (confirmedRootCause && rca.confirmed) lines.push(`Confirmed root cause: ${confirmedRootCause}`)
  else if (rca.likelyCause) lines.push(`Likely cause (${rca.confidenceLabel.toLowerCase()} confidence, ${Math.round(rca.confidence * 100)}%): ${rca.likelyCause}`)
  else lines.push("Likely cause: I don't have enough data to determine a likely cause yet.")
  const support = rca.evidence.filter((item) => item.supports).slice(0, 4)
  if (support.length) lines.push(`Evidence: ${support.map((item) => `${item.label}: ${item.value}`).join('; ')}.`)
  if (rca.impactedDependents.length) lines.push(`Potentially impacted dependents: ${rca.impactedDependents.map((dep) => dep.name).join(', ')}.`)
  if (rca.recommendedActions.length) lines.push(`Recommended next steps: ${rca.recommendedActions.join(' ')}`)
  lines.push(rca.limitations)
  return lines.join('\n')
}
