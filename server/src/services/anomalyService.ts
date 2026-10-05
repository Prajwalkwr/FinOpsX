import { Prisma, type AnomalyStatus, type AnomalyType, type IncidentSeverity } from '@prisma/client'
import type { Request } from 'express'
import { notFound } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { pageOf } from '../lib/http.js'
import { createWithPublicId } from '../lib/ids.js'
import { num, prisma } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'
import { evaluateSpike, mean, type SpikeResult } from '../utils/stats.js'
import { kathmanduNow } from '../utils/range.js'
import { writeAudit } from './audit.js'
import { notifyUsers } from './notify.js'
import { getThresholds } from './thresholds.js'

const OPEN_STATUSES: AnomalyStatus[] = ['DETECTED', 'REVIEW', 'CONFIRMED']
const OBSERVED_WINDOW_MIN = 5
const BASELINE_WINDOW_MIN = 60

export function formatMs(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function severityFor(ratio: number | null, score: number): IncidentSeverity {
  if ((ratio ?? 0) >= 5 || score >= 0.95) return 'CRITICAL'
  if ((ratio ?? 0) >= 3 || score >= 0.8) return 'HIGH'
  if (score >= 0.6) return 'MEDIUM'
  return 'LOW'
}

function evidenceOf(result: SpikeResult, extra: Record<string, unknown> = {}) {
  return {
    method: result.method,
    observedWindowMinutes: OBSERVED_WINDOW_MIN,
    baselineWindowMinutes: BASELINE_WINDOW_MIN,
    baselinePoints: result.points,
    baselineMean: Number(result.normal.toFixed(3)),
    observed: Number(result.observed.toFixed(3)),
    zScore: result.z == null ? null : Number(result.z.toFixed(2)),
    ratio: result.ratio == null ? null : Number(result.ratio.toFixed(2)),
    ...extra,
  }
}

type AnomalyRow = Prisma.AnomalyGetPayload<{ include: { institution: true; merchant: true; incident: true } }>

function serialize(row: AnomalyRow) {
  return {
    id: row.id,
    publicId: row.publicId,
    type: row.type,
    severity: row.severity,
    status: row.status,
    score: row.score,
    title: row.title,
    description: row.description,
    method: row.method,
    entityType: row.entityType,
    entityName: row.entityName,
    normalValue: row.normalValue,
    observedValue: row.observedValue,
    detectedAt: row.detectedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    institution: row.institution?.name ?? null,
    merchant: row.merchant?.name ?? null,
    incident: row.incident ? { id: row.incident.publicId, title: row.incident.title, status: row.incident.status } : null,
    evidence: row.evidence ?? null,
    simulated: true,
  }
}

export async function listAnomalies(query: { page: number; limit: number; status?: string; type?: string; severity?: string; q?: string }) {
  const where: Prisma.AnomalyWhereInput = {
    ...(query.status ? { status: query.status as AnomalyStatus } : {}),
    ...(query.type ? { type: query.type as AnomalyType } : {}),
    ...(query.severity ? { severity: query.severity as IncidentSeverity } : {}),
    ...(query.q
      ? {
          OR: [
            { publicId: { contains: query.q, mode: 'insensitive' } },
            { title: { contains: query.q, mode: 'insensitive' } },
            { entityName: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  }
  const skip = (query.page - 1) * query.limit
  const [total, rows] = await prisma.$transaction([
    prisma.anomaly.count({ where }),
    prisma.anomaly.findMany({ where, orderBy: { detectedAt: 'desc' }, skip, take: query.limit, include: { institution: true, merchant: true, incident: true } }),
  ])
  return pageOf(rows.map(serialize), total, query.page, query.limit)
}

export async function getAnomaly(id: string) {
  const row = await prisma.anomaly.findFirst({ where: { OR: [{ id }, { publicId: id }] }, include: { institution: true, merchant: true, incident: true } })
  if (!row) throw notFound('Anomaly not found.')
  const windowStart = new Date(row.detectedAt.getTime() - 10 * 60_000)
  const windowEnd = new Date(row.detectedAt.getTime() + 5 * 60_000)
  const related = await prisma.transaction.findMany({
    where: {
      createdAt: { gte: windowStart, lte: windowEnd },
      ...(row.institutionId ? { institutionId: row.institutionId } : {}),
      ...(row.merchantId ? { merchantId: row.merchantId } : {}),
      ...(row.type === 'FAILURE_RATE_SPIKE' || row.type === 'REPEATED_FAILURE' ? { status: 'FAILED' } : {}),
      ...(row.type === 'HIGH_VALUE_SPIKE' ? { suspicious: true } : {}),
      ...(row.type === 'SETTLEMENT_DELAY' ? { settlementStatus: 'DELAYED' } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { institution: true, merchant: true },
  })
  return {
    ...serialize(row),
    relatedTransactions: related.map((tx) => ({
      transactionId: tx.transactionId,
      status: tx.status,
      amount: num(tx.amount),
      institution: tx.institution.name,
      merchant: tx.merchant.name,
      responseTimeMs: tx.responseTimeMs,
      failureReason: tx.failureReason,
      createdAt: tx.createdAt.toISOString(),
    })),
  }
}

export async function updateAnomaly(id: string, input: { status: 'REVIEW' | 'CONFIRMED' | 'DISMISSED' | 'RESOLVED'; note?: string }, user: AuthUser, req: Request) {
  const row = await prisma.anomaly.findFirst({ where: { OR: [{ id }, { publicId: id }] } })
  if (!row) throw notFound('Anomaly not found.')
  const updated = await prisma.anomaly.update({
    where: { id: row.id },
    data: {
      status: input.status,
      decisionNote: input.note,
      reviewedAt: new Date(),
      reviewedById: user.id,
      resolvedAt: input.status === 'RESOLVED' || input.status === 'DISMISSED' ? new Date() : null,
    },
    include: { institution: true, merchant: true, incident: true },
  })
  const action = { REVIEW: 'REVIEWED_ANOMALY', CONFIRMED: 'CONFIRMED_ANOMALY', DISMISSED: 'DISMISSED_ANOMALY', RESOLVED: 'RESOLVED_ANOMALY' }[input.status]
  await writeAudit({ user, action, resource: 'ANOMALY', resourceId: row.publicId, req, previousValue: { status: row.status }, newValue: { status: input.status, note: input.note ?? null } })
  emit('anomaly:updated', { id: row.publicId, status: input.status })
  return serialize(updated)
}

type OpenInput = {
  type: AnomalyType
  severity: IncidentSeverity
  title: string
  description: string
  method: string
  score: number
  entityType: string
  entityName: string
  normalValue: number
  observedValue: number
  institutionId?: string
  merchantId?: string
  evidence?: Record<string, unknown>
}

/** Opens an anomaly, or refreshes the open one for the same type and entity inside the dedup window. */
async function openAnomaly(input: OpenInput) {
  const since = new Date(Date.now() - 60 * 60_000)
  const existing = await prisma.anomaly.findFirst({
    where: { type: input.type, entityName: input.entityName, status: { in: OPEN_STATUSES }, detectedAt: { gte: since } },
    orderBy: { detectedAt: 'desc' },
  })
  if (existing) {
    const worse = Math.abs(input.observedValue - input.normalValue) > Math.abs((existing.observedValue ?? 0) - (existing.normalValue ?? 0))
    if (worse) {
      await prisma.anomaly.update({
        where: { id: existing.id },
        data: { observedValue: input.observedValue, score: Math.max(existing.score, input.score), description: input.description, evidence: input.evidence as Prisma.InputJsonValue, severity: input.severity },
      })
    }
    return { anomaly: existing, created: false }
  }
  const created = await createWithPublicId(
    async () => 3100 + (await prisma.anomaly.count()) + 1,
    (n) => `ANM-${n}`,
    (publicId) => prisma.anomaly.create({
      data: {
        publicId,
        type: input.type,
        severity: input.severity,
        title: input.title,
        description: input.description,
        method: input.method,
        score: Number(input.score.toFixed(3)),
        entityType: input.entityType,
        entityName: input.entityName,
        normalValue: Number(input.normalValue.toFixed(3)),
        observedValue: Number(input.observedValue.toFixed(3)),
        institutionId: input.institutionId,
        merchantId: input.merchantId,
        evidence: input.evidence as Prisma.InputJsonValue,
      },
    }),
  )
  await notifyUsers({
    preference: 'notifyAnomalies',
    roles: ['SUPER_ADMIN', 'ANALYST'],
    type: 'ANOMALY',
    title: input.title,
    message: input.description,
    severity: input.severity,
    link: `/anomalies?focus=${created.publicId}`,
  })
  emit('anomaly:detected', { id: created.publicId, type: created.type, title: created.title, severity: created.severity })
  return { anomaly: created, created: true }
}

/** Per-transaction threshold checks that run as each synthetic payment is written. */
export async function evaluateTransaction(tx: {
  amount: number
  status: string
  institutionId: string
  merchantId: string
  responseTimeMs: number
  createdAt: Date
  transactionId?: string
}) {
  const thresholds = await getThresholds()
  if (tx.amount >= thresholds.highValueAmount) {
    const merchant = await prisma.merchant.findUnique({ where: { id: tx.merchantId } })
    const avg = await prisma.transaction.aggregate({
      where: { merchantId: tx.merchantId, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
      _avg: { amount: true },
    })
    const normal = num(avg._avg.amount ?? 0) || thresholds.highValueAmount / 10
    await openAnomaly({
      type: 'HIGH_VALUE_SPIKE',
      severity: tx.amount >= thresholds.highValueAmount * 2 ? 'HIGH' : 'MEDIUM',
      title: `High-value payment at ${merchant?.name ?? 'merchant'}`,
      description: `${merchant?.name ?? 'A merchant'} received Rs. ${Math.round(tx.amount).toLocaleString('en-US')} (threshold Rs. ${thresholds.highValueAmount.toLocaleString('en-US')}; 24h average Rs. ${Math.round(normal).toLocaleString('en-US')}).`,
      method: 'threshold',
      score: Math.min(0.99, 0.5 + tx.amount / (thresholds.highValueAmount * 6)),
      entityType: 'MERCHANT',
      entityName: merchant?.name ?? tx.merchantId,
      normalValue: normal,
      observedValue: tx.amount,
      institutionId: tx.institutionId,
      merchantId: tx.merchantId,
      evidence: { method: 'threshold', threshold: thresholds.highValueAmount, merchantAverage24h: Math.round(normal), transactionId: tx.transactionId ?? null },
    })
  }
  const localHour = kathmanduNow(tx.createdAt).getUTCHours()
  if (localHour <= 4 && tx.amount >= 50000) {
    const merchant = await prisma.merchant.findUnique({ where: { id: tx.merchantId } })
    await openAnomaly({
      type: 'UNUSUAL_TIME_ACTIVITY',
      severity: 'MEDIUM',
      title: 'High-value payment during overnight hours',
      description: `Rs. ${Math.round(tx.amount).toLocaleString('en-US')} at ${merchant?.name ?? 'a merchant'} at ${String(localHour).padStart(2, '0')}:00 local time, when activity is normally low.`,
      method: 'threshold',
      score: 0.7,
      entityType: 'MERCHANT',
      entityName: merchant?.name ?? tx.merchantId,
      normalValue: 50000,
      observedValue: tx.amount,
      institutionId: tx.institutionId,
      merchantId: tx.merchantId,
      evidence: { method: 'threshold', localHour, minimumAmount: 50000, transactionId: tx.transactionId ?? null },
    })
  }
}

type MinuteRow = { key: string; minute: Date; total: number; failed: number; latency: number }

function splitWindow(rows: MinuteRow[], observedStart: Date) {
  const baseline = rows.filter((row) => row.minute < new Date(observedStart.getTime() - 60_000))
  const observed = rows.filter((row) => row.minute >= observedStart)
  return { baseline, observed }
}

function weighted(rows: MinuteRow[]) {
  const total = rows.reduce((sum, row) => sum + row.total, 0)
  const failed = rows.reduce((sum, row) => sum + row.failed, 0)
  const latency = total ? rows.reduce((sum, row) => sum + row.latency * row.total, 0) / total : 0
  return { total, failed, latency, failureRate: total ? (failed / total) * 100 : 0 }
}

/** Window detectors: moving-average baselines with z-score, falling back to thresholds when history is short. */
export async function scanWindows() {
  const thresholds = await getThresholds()
  const now = Date.now()
  const observedStart = new Date(now - OBSERVED_WINDOW_MIN * 60_000)
  const baselineStart = new Date(now - (OBSERVED_WINDOW_MIN + BASELINE_WINDOW_MIN) * 60_000)
  const dayStart = new Date(now - 24 * 3600_000)
  const results: string[] = []
  const record = async (input: OpenInput) => {
    const { anomaly, created } = await openAnomaly(input)
    if (created) results.push(anomaly.publicId)
  }

  const [institutions, config, instMinutes, instDay] = await Promise.all([
    prisma.institution.findMany({ select: { id: true, name: true, code: true } }),
    prisma.simulatorConfig.findUnique({ where: { id: 'default' } }),
    prisma.$queryRaw<MinuteRow[]>(Prisma.sql`
      SELECT "institutionId" AS key, date_trunc('minute', "createdAt") AS minute, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed, AVG("responseTimeMs")::float AS latency
      FROM "Transaction" WHERE "createdAt" >= ${baselineStart} GROUP BY 1, 2`),
    prisma.$queryRaw<Array<{ key: string; total: number; failed: number; latency: number }>>(Prisma.sql`
      SELECT "institutionId" AS key, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed, AVG("responseTimeMs")::float AS latency
      FROM "Transaction" WHERE "createdAt" >= ${dayStart} AND "createdAt" < ${observedStart} GROUP BY 1`),
  ])
  const byId = new Map(institutions.map((row) => [row.id, row]))
  const dayById = new Map(instDay.map((row) => [row.key, row]))

  const failureHits: Array<{ institutionId: string; result: SpikeResult; total: number; failed: number }> = []
  for (const institution of institutions) {
    const rows = instMinutes.filter((row) => row.key === institution.id)
    const { baseline, observed } = splitWindow(rows, observedStart)
    const window = weighted(observed)
    if (window.total < 10) continue
    const day = dayById.get(institution.id)
    const failure = evaluateSpike({
      baseline: baseline.filter((row) => row.total >= 3).map((row) => (row.failed / row.total) * 100),
      observed: window.failureRate,
      fallbackNormal: day && day.total >= 20 ? Math.max(0.5, (day.failed / day.total) * 100) : null,
      minRatio: 2,
      minObserved: thresholds.failureRatePct,
    })
    if (failure.anomalous) failureHits.push({ institutionId: institution.id, result: failure, total: window.total, failed: window.failed })
    const latency = evaluateSpike({
      baseline: baseline.filter((row) => row.total >= 2).map((row) => row.latency),
      observed: window.latency,
      fallbackNormal: day && day.total >= 20 ? day.latency : null,
      minRatio: 1.8,
      minObserved: Math.min(thresholds.latencyMs, 3000),
    })
    if (latency.anomalous) {
      await record({
        type: 'API_LATENCY_SPIKE',
        severity: severityFor(latency.ratio, latency.score),
        title: `${institution.name} API latency spike`,
        description: `${institution.name} average bank API latency rose from ${formatMs(latency.normal)} to ${formatMs(latency.observed)} over the last ${OBSERVED_WINDOW_MIN} minutes${latency.z != null ? ` (z-score ${latency.z.toFixed(1)} against the ${BASELINE_WINDOW_MIN}-minute moving baseline)` : ' (compared with the 24-hour average)'}.`,
        method: latency.method,
        score: latency.score,
        entityType: 'INSTITUTION',
        entityName: institution.name,
        normalValue: latency.normal,
        observedValue: latency.observed,
        institutionId: institution.id,
        evidence: evidenceOf(latency, { unit: 'ms', transactionsInWindow: window.total }),
      })
    }
  }
  if (failureHits.length >= 3) {
    const totals = weighted(instMinutes.filter((row) => row.minute >= observedStart))
    const normal = failureHits.reduce((sum, hit) => sum + hit.result.normal, 0) / failureHits.length
    const ratio = normal > 0 ? totals.failureRate / normal : null
    const score = Math.max(...failureHits.map((hit) => hit.result.score))
    await record({
      type: 'FAILURE_RATE_SPIKE',
      severity: severityFor(ratio, score),
      title: 'Platform-wide payment failure spike',
      description: `Failure rate across ${failureHits.length} institutions rose from ${normal.toFixed(1)}% to ${totals.failureRate.toFixed(1)}% over the last ${OBSERVED_WINDOW_MIN} minutes (${totals.failed} of ${totals.total} payments failed).`,
      method: failureHits[0].result.method,
      score,
      entityType: 'PLATFORM',
      entityName: 'All institutions',
      normalValue: normal,
      observedValue: totals.failureRate,
      evidence: { method: failureHits[0].result.method, unit: '%', institutions: failureHits.map((hit) => byId.get(hit.institutionId)?.name), failed: totals.failed, total: totals.total },
    })
  } else {
    for (const hit of failureHits) {
      const institution = byId.get(hit.institutionId)
      if (!institution) continue
      await record({
        type: 'FAILURE_RATE_SPIKE',
        severity: severityFor(hit.result.ratio, hit.result.score),
        title: `${institution.name} failure rate spike`,
        description: `${institution.name} failure rate rose from ${hit.result.normal.toFixed(1)}% to ${hit.result.observed.toFixed(1)}% over the last ${OBSERVED_WINDOW_MIN} minutes (${hit.failed} of ${hit.total} payments failed).`,
        method: hit.result.method,
        score: hit.result.score,
        entityType: 'INSTITUTION',
        entityName: institution.name,
        normalValue: hit.result.normal,
        observedValue: hit.result.observed,
        institutionId: institution.id,
        evidence: evidenceOf(hit.result, { unit: '%', failed: hit.failed, total: hit.total }),
      })
    }
  }

  const repeated = await prisma.transaction.groupBy({
    by: ['institutionId', 'failureReason'],
    where: { status: 'FAILED', createdAt: { gte: new Date(now - 10 * 60_000) }, failureReason: { not: null } },
    _count: { _all: true },
  })
  for (const group of repeated) {
    if (group._count._all < thresholds.repeatedFailureCount) continue
    const institution = byId.get(group.institutionId)
    if (!institution) continue
    const reason = String(group.failureReason).replace(/_/g, ' ').toLowerCase()
    await record({
      type: 'REPEATED_FAILURE',
      severity: group._count._all >= thresholds.repeatedFailureCount * 3 ? 'HIGH' : 'MEDIUM',
      title: `Repeated ${reason} failures at ${institution.name}`,
      description: `${group._count._all} payments at ${institution.name} failed with "${reason}" in the last 10 minutes (threshold ${thresholds.repeatedFailureCount}).`,
      method: 'threshold',
      score: Math.min(0.99, 0.55 + group._count._all / (thresholds.repeatedFailureCount * 10)),
      entityType: 'INSTITUTION',
      entityName: `${institution.name} · ${reason}`,
      normalValue: thresholds.repeatedFailureCount,
      observedValue: group._count._all,
      institutionId: institution.id,
      evidence: { method: 'threshold', windowMinutes: 10, threshold: thresholds.repeatedFailureCount, failureReason: group.failureReason, count: group._count._all },
    })
  }

  const endpointMinutes = await prisma.$queryRaw<MinuteRow[]>(Prisma.sql`
    SELECT e.method || ' ' || e.endpoint AS key, date_trunc('minute', c."createdAt") AS minute, COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE c."statusCode" >= 500)::int AS failed, AVG(c."latencyMs")::float AS latency
    FROM "ApiCall" c JOIN "ApiMetric" e ON e.id = c."endpointId"
    WHERE c."createdAt" >= ${baselineStart} AND e.endpoint NOT IN ('/payments', '/bank/authorize')
    GROUP BY 1, 2`)
  for (const key of [...new Set(endpointMinutes.map((row) => row.key))]) {
    const { baseline, observed } = splitWindow(endpointMinutes.filter((row) => row.key === key), observedStart)
    const window = weighted(observed)
    if (window.total < 10) continue
    const latency = evaluateSpike({ baseline: baseline.map((row) => row.latency), observed: window.latency, minRatio: 2.5, minObserved: 500 })
    if (latency.anomalous) {
      await record({
        type: 'API_LATENCY_SPIKE',
        severity: severityFor(latency.ratio, latency.score),
        title: `${key} latency spike`,
        description: `${key} average latency rose from ${formatMs(latency.normal)} to ${formatMs(latency.observed)} over the last ${OBSERVED_WINDOW_MIN} minutes.`,
        method: latency.method,
        score: latency.score,
        entityType: 'API_ENDPOINT',
        entityName: key,
        normalValue: latency.normal,
        observedValue: latency.observed,
        evidence: evidenceOf(latency, { unit: 'ms', callsInWindow: window.total }),
      })
    }
    const errors = evaluateSpike({ baseline: baseline.filter((row) => row.total >= 3).map((row) => (row.failed / row.total) * 100), observed: window.failureRate, minRatio: 3, minObserved: 10 })
    if (errors.anomalous) {
      await record({
        type: 'FAILURE_RATE_SPIKE',
        severity: severityFor(errors.ratio, errors.score),
        title: `${key} error rate spike`,
        description: `${key} 5xx error rate rose from ${errors.normal.toFixed(1)}% to ${errors.observed.toFixed(1)}% over the last ${OBSERVED_WINDOW_MIN} minutes (${window.failed} of ${window.total} calls).`,
        method: errors.method,
        score: errors.score,
        entityType: 'API_ENDPOINT',
        entityName: key,
        normalValue: errors.normal,
        observedValue: errors.observed,
        evidence: evidenceOf(errors, { unit: '%', failed: window.failed, total: window.total }),
      })
    }
  }

  const totalsByMinute = new Map<number, number>()
  for (const row of instMinutes) totalsByMinute.set(row.minute.getTime(), (totalsByMinute.get(row.minute.getTime()) ?? 0) + row.total)
  const completeBaseline = [...totalsByMinute.entries()].filter(([minute]) => minute < observedStart.getTime() - 60_000).map(([, total]) => total)
  const observedCount = instMinutes.filter((row) => row.minute >= observedStart).reduce((sum, row) => sum + row.total, 0)
  const observedRate = observedCount / OBSERVED_WINDOW_MIN
  // After a restart or reseed the hour contains sparse seeded minutes; that history is not a usable baseline for the configured rate.
  const warmingUp = Boolean(config?.running) && (completeBaseline.length < 30 || mean(completeBaseline) < config!.tpm * 0.6)
  const volume = evaluateSpike({
    baseline: warmingUp ? [] : completeBaseline,
    observed: observedRate,
    fallbackNormal: config?.running ? config.tpm : null,
    minRatio: 1 + thresholds.volumeAnomalyPct / 100,
    minObserved: 20,
  })
  if (volume.anomalous) {
    await record({
      type: 'TRANSACTION_VOLUME_SPIKE',
      severity: severityFor(volume.ratio, volume.score),
      title: 'Transaction volume spike',
      description: `Platform volume rose from ${Math.round(volume.normal)} to ${Math.round(volume.observed)} transactions per minute over the last ${OBSERVED_WINDOW_MIN} minutes.`,
      method: volume.method,
      score: volume.score,
      entityType: 'PLATFORM',
      entityName: 'Platform volume',
      normalValue: volume.normal,
      observedValue: volume.observed,
      evidence: evidenceOf(volume, { unit: 'tpm' }),
    })
  }

  const merchantBuckets = await prisma.$queryRaw<Array<{ key: string; bucket: number; total: number }>>(Prisma.sql`
    SELECT "merchantId" AS key, floor(extract(epoch FROM (${new Date(now)}::timestamp - "createdAt")) / 600)::int AS bucket, COUNT(*)::int AS total
    FROM "Transaction" WHERE "createdAt" >= ${new Date(now - 70 * 60_000)} GROUP BY 1, 2`)
  const merchantIds = [...new Set(merchantBuckets.map((row) => row.key))]
  const merchantCount = Math.max(1, await prisma.merchant.count())
  for (const merchantId of merchantIds) {
    const rows = merchantBuckets.filter((row) => row.key === merchantId)
    const observed = rows.find((row) => row.bucket === 0)?.total ?? 0
    if (observed < 20) continue
    const baseline = [1, 2, 3, 4, 5, 6].map((bucket) => rows.find((row) => row.bucket === bucket)?.total ?? 0)
    const hasHistory = baseline.some((value) => value > 0)
    const result = evaluateSpike({
      baseline: hasHistory ? baseline : [],
      observed,
      fallbackNormal: config?.running ? (config.tpm * 10) / merchantCount : null,
      minRatio: 2.5,
      minObserved: 20,
    })
    if (!result.anomalous) continue
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } })
    await record({
      type: 'MERCHANT_VOLUME_SPIKE',
      severity: severityFor(result.ratio, result.score),
      title: `${merchant?.name ?? 'Merchant'} volume spike`,
      description: `${merchant?.name ?? 'A merchant'} processed ${observed} payments in the last 10 minutes against a moving average of ${result.normal.toFixed(1)} per 10 minutes.`,
      method: result.method,
      score: result.score,
      entityType: 'MERCHANT',
      entityName: merchant?.name ?? merchantId,
      normalValue: result.normal,
      observedValue: observed,
      merchantId,
      evidence: evidenceOf(result, { unit: 'transactions per 10 minutes', observedWindowMinutes: 10 }),
    })
  }

  const windowTotal = instMinutes.filter((row) => row.minute >= new Date(now - 10 * 60_000)).reduce((sum, row) => sum + row.total, 0)
  const dayTotal = instDay.reduce((sum, row) => sum + row.total, 0)
  if (windowTotal >= 60 && dayTotal >= 200) {
    for (const institution of institutions) {
      const recent = instMinutes.filter((row) => row.key === institution.id && row.minute >= new Date(now - 10 * 60_000)).reduce((sum, row) => sum + row.total, 0)
      const share = (recent / windowTotal) * 100
      const normalShare = ((dayById.get(institution.id)?.total ?? 0) / dayTotal) * 100
      if (normalShare < 2) continue
      const ratio = share / normalShare
      if (ratio < 2 && ratio > 0.35) continue
      await record({
        type: 'INSTITUTION_ACTIVITY',
        severity: ratio >= 3 || ratio <= 0.2 ? 'HIGH' : 'MEDIUM',
        title: `${institution.name} activity ${ratio >= 2 ? 'surge' : 'drop'}`,
        description: `${institution.name} handled ${share.toFixed(1)}% of payments in the last 10 minutes compared with ${normalShare.toFixed(1)}% over the previous 24 hours.`,
        method: 'threshold',
        score: Math.min(0.95, 0.55 + Math.abs(Math.log(Math.max(ratio, 0.01))) / 4),
        entityType: 'INSTITUTION',
        entityName: `${institution.name} share`,
        normalValue: normalShare,
        observedValue: share,
        institutionId: institution.id,
        evidence: { method: 'threshold', unit: '% of volume', windowMinutes: 10, recentTransactions: recent, windowTotal, ratio: Number(ratio.toFixed(2)) },
      })
    }
  }

  const delayed = await prisma.transaction.groupBy({
    by: ['institutionId'],
    where: { settlementStatus: 'DELAYED', updatedAt: { gte: new Date(now - 30 * 60_000) } },
    _count: { _all: true },
  })
  const delayedTotal = delayed.reduce((sum, row) => sum + row._count._all, 0)
  if (delayedTotal >= 5) {
    const normalDelayed = await prisma.transaction.count({ where: { settlementStatus: 'DELAYED', createdAt: { gte: dayStart, lt: new Date(now - 30 * 60_000) } } })
    const normalPer30 = normalDelayed / 47
    await record({
      type: 'SETTLEMENT_DELAY',
      severity: delayedTotal >= 50 ? 'HIGH' : 'MEDIUM',
      title: 'Settlement batches delayed',
      description: `${delayedTotal} successful payments missed their settlement window in the last 30 minutes across ${delayed.length} institutions (normal: ${normalPer30.toFixed(1)} per 30 minutes).`,
      method: 'threshold',
      score: Math.min(0.97, 0.6 + delayedTotal / 300),
      entityType: 'SERVICE',
      entityName: 'Settlement Service',
      normalValue: normalPer30,
      observedValue: delayedTotal,
      evidence: { method: 'threshold', threshold: 5, windowMinutes: 30, byInstitution: delayed.map((row) => ({ institution: byId.get(row.institutionId)?.name, count: row._count._all })) },
    })
  }
  return results
}
