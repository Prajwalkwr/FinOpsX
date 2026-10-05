import type { AnomalyStatus, AnomalyType, IncidentSeverity } from '@prisma/client'
import type { Request } from 'express'
import { notFound } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { pageOf } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'
import { isolationStyleScore, zScore } from '../utils/stats.js'
import { kathmanduNow } from '../utils/range.js'
import { writeAudit } from './audit.js'
import { notifyUsers } from './notify.js'
import { getThresholds } from './thresholds.js'

export async function listAnomalies(query: { page: number; limit: number; status?: string; type?: string; q?: string }) {
  const where = {
    ...(query.status ? { status: query.status as AnomalyStatus } : {}),
    ...(query.type ? { type: query.type as AnomalyType } : {}),
    ...(query.q
      ? {
          OR: [
            { publicId: { contains: query.q, mode: 'insensitive' as const } },
            { title: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }
  const skip = (query.page - 1) * query.limit
  const [total, rows] = await prisma.$transaction([
    prisma.anomaly.count({ where }),
    prisma.anomaly.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      skip,
      take: query.limit,
      include: { institution: true, merchant: true },
    }),
  ])
  return pageOf(rows.map(serialize), total, query.page, query.limit)
}

function serialize(row: {
  id: string
  publicId: string
  type: string
  severity: string
  status: string
  score: number
  title: string
  description: string
  method: string
  detectedAt: Date
  decisionNote: string | null
  institution?: { name: string } | null
  merchant?: { name: string } | null
  evidence?: unknown
}) {
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
    detectedAt: row.detectedAt.toISOString(),
    decisionNote: row.decisionNote,
    institution: row.institution?.name ?? null,
    merchant: row.merchant?.name ?? null,
    evidence: row.evidence ?? null,
    simulated: true,
  }
}

export async function updateAnomaly(id: string, input: { status: 'REVIEW' | 'CONFIRMED' | 'DISMISSED'; note?: string }, user: AuthUser, req: Request) {
  const row = await prisma.anomaly.findFirst({ where: { OR: [{ id }, { publicId: id }] } })
  if (!row) throw notFound('Anomaly not found.')
  const updated = await prisma.anomaly.update({
    where: { id: row.id },
    data: {
      status: input.status,
      decisionNote: input.note,
      reviewedAt: new Date(),
      reviewedById: user.id,
    },
  })
  await writeAudit({
    user,
    action: input.status === 'DISMISSED' ? 'DISMISSED_ANOMALY' : 'CONFIRMED_ANOMALY',
    resource: 'ANOMALY',
    resourceId: row.publicId,
    req,
    previousValue: { status: row.status },
    newValue: { status: input.status, note: input.note ?? null },
  })
  return serialize({ ...row, ...updated })
}

async function openAnomaly(input: {
  type: AnomalyType
  severity: IncidentSeverity
  title: string
  description: string
  method: string
  score: number
  institutionId?: string
  merchantId?: string
  evidence?: unknown
}) {
  const since = new Date(Date.now() - 60 * 60_000)
  const existing = await prisma.anomaly.findFirst({
    where: {
      type: input.type,
      status: { in: ['DETECTED', 'REVIEW'] },
      detectedAt: { gte: since },
      institutionId: input.institutionId,
      merchantId: input.merchantId,
    },
  })
  if (existing) return existing
  const count = await prisma.anomaly.count()
  const created = await prisma.anomaly.create({
    data: {
      publicId: `ANM-${2000 + count + 1}`,
      type: input.type,
      severity: input.severity,
      title: input.title,
      description: input.description,
      method: input.method,
      score: input.score,
      institutionId: input.institutionId,
      merchantId: input.merchantId,
      evidence: input.evidence as object | undefined,
    },
  })
  await notifyUsers({
    preference: 'notifyAnomalies',
    roles: ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ANALYST', 'ENGINEER'],
    type: 'ANOMALY',
    title: input.title,
    message: input.description,
    severity: input.severity,
    link: '/anomalies',
  })
  emit('anomaly:detected', { id: created.publicId, type: created.type, title: created.title, severity: created.severity })
  return created
}

export async function evaluateTransaction(tx: {
  amount: number
  status: string
  institutionId: string
  merchantId: string
  responseTimeMs: number
  createdAt: Date
}) {
  const thresholds = await getThresholds()
  if (tx.amount >= thresholds.highValueAmount) {
    const [institution, merchant] = await Promise.all([
      prisma.institution.findUnique({ where: { id: tx.institutionId } }),
      prisma.merchant.findUnique({ where: { id: tx.merchantId } }),
    ])
    await openAnomaly({
      type: 'HIGH_VALUE_SPIKE',
      severity: tx.amount >= thresholds.highValueAmount * 2 ? 'HIGH' : 'MEDIUM',
      title: 'High value spike',
      description: `${merchant?.name ?? 'A merchant'} recorded Rs. ${Math.round(tx.amount).toLocaleString('en-US')} against the configured threshold.`,
      method: 'rule',
      score: Math.min(0.99, tx.amount / (thresholds.highValueAmount * 3)),
      institutionId: tx.institutionId,
      merchantId: tx.merchantId,
      evidence: { amount: tx.amount, threshold: thresholds.highValueAmount, institution: institution?.name },
    })
  }
  const localHour = kathmanduNow(tx.createdAt).getUTCHours()
  if (localHour <= 4 && tx.amount >= 50000) {
    await openAnomaly({
      type: 'UNUSUAL_TIME_ACTIVITY',
      severity: 'MEDIUM',
      title: 'Unusual time activity',
      description: 'A high-value transaction arrived during local overnight hours.',
      method: 'rule',
      score: 0.72,
      institutionId: tx.institutionId,
      merchantId: tx.merchantId,
    })
  }
  if (tx.responseTimeMs >= thresholds.latencyMs) {
    await openAnomaly({
      type: 'API_LATENCY_ANOMALY',
      severity: 'HIGH',
      title: 'API latency anomaly',
      description: `Response time reached ${tx.responseTimeMs}ms.`,
      method: 'rule',
      score: 0.88,
      institutionId: tx.institutionId,
    })
  }
}

export async function scanWindows() {
  const thresholds = await getThresholds()
  const now = Date.now()
  const recentStart = new Date(now - 10 * 60_000)
  const previousStart = new Date(now - 20 * 60_000)
  const [recent, previous, failedGroups, amounts] = await Promise.all([
    prisma.transaction.count({ where: { createdAt: { gte: recentStart } } }),
    prisma.transaction.count({ where: { createdAt: { gte: previousStart, lt: recentStart } } }),
    prisma.transaction.groupBy({
      by: ['institutionId'],
      where: { status: 'FAILED', createdAt: { gte: recentStart } },
      _count: { _all: true },
    }),
    prisma.transaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: { amount: true, merchantId: true, institutionId: true },
    }),
  ])
  if (previous >= 10) {
    const increase = ((recent - previous) / previous) * 100
    if (increase >= thresholds.volumeAnomalyPct) {
      await openAnomaly({
        type: 'TRANSACTION_VOLUME_SPIKE',
        severity: 'HIGH',
        title: 'Transaction volume spike',
        description: `Volume in the last 10 minutes is ${increase.toFixed(0)}% above the previous window.`,
        method: 'moving-average',
        score: Math.min(0.99, increase / 200),
      })
    }
  }
  for (const group of failedGroups) {
    if (group._count._all >= thresholds.repeatedFailureCount) {
      const institution = await prisma.institution.findUnique({ where: { id: group.institutionId } })
      await openAnomaly({
        type: group._count._all >= thresholds.repeatedFailureCount + 4 ? 'BANK_FAILURE_SPIKE' : 'REPEATED_FAILURE',
        severity: 'HIGH',
        title: 'Repeated transaction failures',
        description: `${institution?.name ?? 'An institution'} recorded ${group._count._all} failures in 10 minutes.`,
        method: 'rule',
        score: 0.9,
        institutionId: group.institutionId,
      })
    }
  }
  const values = amounts.map((row) => Number(row.amount))
  if (values.length >= 12) {
    const latest = values[0]
    const score = zScore(values.slice(1), latest)
    const isolation = isolationStyleScore(values.slice(1), latest)
    if (score >= 3 || isolation >= 0.75) {
      await openAnomaly({
        type: 'HIGH_VALUE_SPIKE',
        severity: 'MEDIUM',
        title: 'Statistical amount outlier',
        description: `Latest amount is ${score.toFixed(2)} standard deviations from the recent moving window.`,
        method: 'z-score',
        score: Math.min(0.99, Math.max(score / 5, isolation)),
        institutionId: amounts[0]?.institutionId,
        merchantId: amounts[0]?.merchantId,
        evidence: { zScore: score, isolationStyleScore: isolation },
      })
    }
  }
}
