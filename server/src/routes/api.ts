import type { Prisma } from '@prisma/client'
import { Router, type Request } from 'express'
import swaggerUi from 'swagger-ui-express'
import { z } from 'zod'
import { ANOMALY_TYPES, INCIDENT_STATUSES, JOB_TYPES, REPORT_TYPES, SCENARIOS, can } from '@finopsx/shared'
import { env } from '../config/env.js'
import { forbidden, notFound, unprocessable } from '../lib/errors.js'
import { asyncHandler, ok, pageOf, requirePermission, requireUser } from '../lib/http.js'
import { num, prisma } from '../lib/prisma.js'
import { authenticate, idempotency, rateLimit, validate } from '../middleware/common.js'
import { openApi } from '../openapi.js'
import { answerQuestion } from '../services/ai/assistant.js'
import { executeQuery, toCsv } from '../services/ai/queryExecutor.js'
import { parseQuestion, structuredQuerySchema } from '../services/ai/queryParser.js'
import { getAnomaly, listAnomalies, updateAnomaly } from '../services/anomalyService.js'
import { getEndpoint, listEndpoints } from '../services/apiObservability.js'
import { writeAudit } from '../services/audit.js'
import { demoAccounts, forgotPassword, login, logout, refresh, resetPassword, toPublicUser } from '../services/authService.js'
import { affectedRecords, dataQualityOverview, runDataQualityScan, updateIssue } from '../services/dataQualityService.js'
import { infrastructure, systemHealth } from '../services/healthService.js'
import {
  addNote, assignIncident, changeSeverity, changeStatus, createIncident, getIncident, listIncidents, reopenIncident, rerunRca, resolveIncident, updateDetails,
} from '../services/incidentService.js'
import { getJob, jobCatalog, listJobs, triggerJob } from '../services/jobService.js'
import { liveSnapshot } from '../services/liveMetrics.js'
import { dashboardOverview, dashboardSummary, institutionPerformance, transactionAggregates, volumeSeries } from '../services/metricsService.js'
import { getRun, listRuns, reconciliationSummary, runReconciliation, updateRun } from '../services/reconciliationService.js'
import { deleteReport, generateReport, getReport, listReports, listSchedules, renderReport, updateSchedule } from '../services/reportService.js'
import { serviceMap } from '../services/serviceMapService.js'
import { listSettlements } from '../services/settlementService.js'
import { getThresholds } from '../services/thresholds.js'
import { buildTransactionWhere, getTransaction, investigateTransaction, listTransactions } from '../services/transactionService.js'
import { createUser, listUsers, resetUserPassword, updateProfile, updateThresholds, updateUser } from '../services/userService.js'
import { resetSimulator, resolveScenario, simulatorStatus, startScenario, startSimulator, stopSimulator, updateSimulator } from '../simulator/engine.js'
import { resolveRange } from '../utils/range.js'

const password = z.string().min(8).max(128).regex(/[a-z]/, 'Needs a lowercase letter').regex(/[A-Z]/, 'Needs an uppercase letter').regex(/\d/, 'Needs a number')
const paging = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})
const rangeKey = z.enum(['1h', '6h', '24h', 'today', 'yesterday', '7d', '30d', 'custom'])
const rangeQuery = z.object({ range: rangeKey.optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() })
const severity = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
const idParam = z.string().trim().min(1).max(64).regex(/^[\w-]+$/)
const ROLE_ENUM = z.enum(['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ANALYST', 'ENGINEER', 'AUDITOR'])

function param(req: Request, name = 'id') {
  const value = req.params[name]
  return idParam.parse(Array.isArray(value) ? value[0] : value)
}

function rangeFrom(query: unknown, fallback = '24h') {
  const parsed = rangeQuery.parse(query)
  if (parsed.range === 'custom' && (!parsed.from || !parsed.to)) throw unprocessable('A custom range needs both from and to.')
  return resolveRange({ range: parsed.range ?? fallback, from: parsed.from, to: parsed.to })
}

export const api = Router()

api.use('/docs', swaggerUi.serve, swaggerUi.setup(openApi))

api.get('/auth/demo-accounts', (_req, res) => {
  ok(res, { accounts: demoAccounts(), production: env.isProd })
})

api.post('/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 10, prefix: 'auth' }), validate(z.object({
  body: z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128), rememberMe: z.boolean().optional() }),
})), asyncHandler(async (req, res) => {
  const body = (req as typeof req & { validated: { body: { email: string; password: string; rememberMe?: boolean } } }).validated.body
  ok(res, await login(body, req))
}))

api.post('/auth/refresh', rateLimit({ windowMs: 60_000, max: 30, prefix: 'refresh' }), asyncHandler(async (req, res) => {
  const token = z.object({ refreshToken: z.string().min(10).max(2048) }).parse(req.body).refreshToken
  ok(res, await refresh(token, req))
}))

api.post('/auth/forgot-password', rateLimit({ windowMs: 15 * 60_000, max: 10, prefix: 'forgot' }), asyncHandler(async (req, res) => {
  const email = z.object({ email: z.string().trim().email().max(254) }).parse(req.body).email
  ok(res, await forgotPassword(email))
}))

api.post('/auth/reset-password', rateLimit({ windowMs: 15 * 60_000, max: 10, prefix: 'reset' }), asyncHandler(async (req, res) => {
  const body = z.object({ token: z.string().min(10).max(512), password }).parse(req.body)
  await resetPassword(body.token, body.password, req)
  ok(res, { message: 'Password updated. Sign in with the new password.' })
}))

api.use(authenticate)
api.use(rateLimit({ windowMs: 60_000, max: 300, prefix: 'api' }))

api.post('/auth/logout', asyncHandler(async (req, res) => {
  await logout(typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined, req)
  ok(res, { message: 'Signed out.' })
}))

api.get('/auth/me', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const row = await prisma.user.findUnique({ where: { id: user.id }, include: { role: true } })
  if (!row) throw notFound('User not found.')
  ok(res, toPublicUser(row))
}))

/* ---------------------------------------------------------------- Dashboard */

api.get('/dashboard/overview', requirePermission('dashboard:view'), asyncHandler(async (req, res) => {
  const query = rangeQuery.parse(req.query)
  const { role } = requireUser(req)
  const overview = await dashboardOverview({ range: query.range ?? '24h', from: query.from, to: query.to })
  ok(res, {
    ...overview,
    recent: can(role, 'transactions:view') ? overview.recent : [],
    activeIncidents: can(role, 'incidents:view') ? overview.activeIncidents : [],
    anomalies: can(role, 'anomalies:view') ? overview.anomalies : [],
    institutions: can(role, 'institutions:view') ? overview.institutions : [],
    services: can(role, 'services:view') || can(role, 'system:view') ? overview.services : [],
    aiAlerts: overview.aiAlerts.filter((alert) => {
      if (alert.href.startsWith('/incidents')) return can(role, 'incidents:view')
      if (alert.href.startsWith('/anomalies')) return can(role, 'anomalies:view')
      if (alert.href.startsWith('/transactions')) return can(role, 'transactions:view')
      if (alert.href.startsWith('/institutions')) return can(role, 'institutions:view')
      if (alert.href.startsWith('/system-health') || alert.href.startsWith('/service-map')) return can(role, 'system:view')
      return true
    }),
  })
}))

api.get('/dashboard/summary', requirePermission('dashboard:view'), asyncHandler(async (req, res) => {
  const query = rangeQuery.parse(req.query)
  ok(res, await dashboardSummary({ range: query.range ?? '24h', from: query.from, to: query.to }))
}))

api.get('/dashboard/volume', requirePermission('dashboard:view'), asyncHandler(async (req, res) => {
  ok(res, await volumeSeries(rangeFrom(req.query)))
}))

api.get('/dashboard/outcomes', requirePermission('dashboard:view'), asyncHandler(async (req, res) => {
  const metrics = await transactionAggregates(rangeFrom(req.query))
  ok(res, { success: metrics.successRate, failed: metrics.failureRate, pending: metrics.pendingRate, counts: metrics.counts })
}))

api.get('/realtime/snapshot', requirePermission('dashboard:view'), asyncHandler(async (_req, res) => {
  ok(res, await liveSnapshot())
}))

/* ------------------------------------------------------------- Transactions */

const transactionQuery = z.object({
  ...paging.shape,
  q: z.string().trim().max(80).optional(),
  status: z.enum(['ALL', 'SUCCESSFUL', 'SUCCESS', 'SETTLED', 'FAILED', 'PENDING', 'REVERSED', 'INITIATED', 'PROCESSING', 'REFUNDED', 'CANCELLED', 'SUSPICIOUS', 'HIGH_VALUE']).optional(),
  preset: z.string().max(20).optional(),
  institutionId: z.string().max(40).optional(),
  institution: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  merchantId: z.string().max(40).optional(),
  paymentMethod: z.enum(['QR', 'WALLET', 'BANK_TRANSFER', 'CARD', 'ACCOUNT_PAYMENT']).optional(),
  settlementStatus: z.enum(['NOT_STARTED', 'QUEUED', 'SETTLED', 'DELAYED', 'FAILED']).optional(),
  failureReason: z.enum(['TIMEOUT', 'BANK_API_ERROR', 'INSUFFICIENT_FUNDS', 'NETWORK_ERROR', 'INVALID_REQUEST', 'SERVICE_UNAVAILABLE', 'DUPLICATE_TRANSACTION', 'AUTHENTICATION_FAILURE', 'SETTLEMENT_DELAY']).optional(),
  minAmount: z.coerce.number().nonnegative().optional(),
  maxAmount: z.coerce.number().positive().optional(),
  range: z.enum(['1h', '6h', '24h', 'today', 'yesterday', '7d', '30d', 'all']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  minRisk: z.coerce.number().min(0).max(100).optional(),
  sort: z.enum(['createdAt', 'amount', 'responseTimeMs', 'riskScore', 'status']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  suspicious: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  highValue: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
}).refine((value) => value.minAmount == null || value.maxAmount == null || value.minAmount <= value.maxAmount, { message: 'minAmount must be less than or equal to maxAmount', path: ['minAmount'] })

api.get('/transactions', requirePermission('transactions:view'), asyncHandler(async (req, res) => {
  ok(res, await listTransactions(transactionQuery.parse(req.query)))
}))

api.get('/transactions/export', requirePermission('transactions:view'), rateLimit({ windowMs: 60_000, max: 10, prefix: 'export' }), asyncHandler(async (req, res) => {
  const query = transactionQuery.parse(req.query)
  const where = await buildTransactionWhere(query)
  const rows = await prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10000, include: { institution: true, merchant: true } })
  const csv = toCsv(
    ['transactionId', 'correlationId', 'createdAt', 'status', 'amount', 'currency', 'paymentMethod', 'institution', 'merchant', 'responseCode', 'responseTimeMs', 'failureReason', 'settlementStatus'],
    rows.map((row) => [row.transactionId, row.correlationId, row.createdAt.toISOString(), row.status, num(row.amount), row.currency, row.paymentMethod, row.institution.name, row.merchant.name, row.responseCode, row.responseTimeMs, row.failureReason, row.settlementStatus]),
  )
  await writeAudit({ user: requireUser(req), action: 'EXPORTED_TRANSACTIONS', resource: 'TRANSACTION', req, newValue: { rows: rows.length } })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="finopsx-transactions.csv"')
  res.send(`\uFEFF${csv}`)
}))

api.get('/transactions/:id', requirePermission('transactions:view'), asyncHandler(async (req, res) => {
  ok(res, await getTransaction(param(req)))
}))

api.post('/transactions/:id/investigate', requirePermission('transactions:investigate'), idempotency, asyncHandler(async (req, res) => {
  ok(res, await investigateTransaction(param(req), requireUser(req), req))
}))

/* ------------------------------------------------------------- Institutions */

api.get('/institutions', requirePermission('institutions:view'), asyncHandler(async (req, res) => {
  ok(res, await institutionPerformance(rangeFrom(req.query, '24h')))
}))

api.get('/institutions/:id', requirePermission('institutions:view'), asyncHandler(async (req, res) => {
  const range = rangeFrom(req.query, '24h')
  const id = param(req)
  const institution = await prisma.institution.findFirst({ where: { OR: [{ id }, { code: id.toUpperCase() }] } })
  if (!institution) throw notFound('Institution not found.')
  const rows = await institutionPerformance(range)
  const row = rows.find((item) => item.id === institution.id)!
  const [reasons, volume, latency, incidents, ledger] = await Promise.all([
    prisma.transaction.groupBy({ by: ['failureReason'], where: { institutionId: institution.id, status: 'FAILED', createdAt: { gte: range.from, lte: range.to } }, _count: { _all: true }, orderBy: { _count: { failureReason: 'desc' } }, take: 8 }),
    volumeSeries(range, { institutionId: institution.id }),
    transactionAggregates(range, { institutionId: institution.id }),
    prisma.incident.findMany({ where: { institutions: { some: { institutionId: institution.id } } }, orderBy: { detectedAt: 'desc' }, take: 10 }),
    prisma.institutionLedgerEntry.count({ where: { institutionId: institution.id, recordedAt: { gte: range.from, lte: range.to } } }),
  ])
  ok(res, {
    ...row,
    range: { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label },
    p95Ms: latency.p95Ms,
    p99Ms: latency.p99Ms,
    pending: latency.pending,
    reversed: latency.reversed,
    ledgerRecords: ledger,
    topFailure: reasons[0]?.failureReason ?? null,
    failureReasons: reasons.map((reason) => ({ reason: reason.failureReason ?? 'UNSPECIFIED', count: reason._count._all })),
    volume,
    incidents: incidents.map((item) => ({ id: item.publicId, title: item.title, severity: item.severity, status: item.status, detectedAt: item.detectedAt.toISOString() })),
  })
}))

/* --------------------------------------------------- Services, system, APIs */

api.get('/services', requirePermission('services:view'), asyncHandler(async (_req, res) => {
  ok(res, (await systemHealth()).services)
}))

api.get('/services/map', requirePermission('services:view'), asyncHandler(async (_req, res) => {
  ok(res, await serviceMap())
}))

api.get('/system/health', requirePermission('system:view'), asyncHandler(async (_req, res) => {
  ok(res, await systemHealth())
}))

api.get('/system/infrastructure', requirePermission('system:view'), asyncHandler(async (req, res) => {
  const hours = z.coerce.number().int().min(1).max(168).default(6).parse(req.query.hours ?? 6)
  ok(res, await infrastructure(hours))
}))

api.get('/apis', requirePermission('apis:view'), asyncHandler(async (req, res) => {
  const window = z.coerce.number().int().min(1).max(360).default(15).parse(req.query.window ?? 15)
  ok(res, await listEndpoints(window))
}))

api.get('/apis/:id', requirePermission('apis:view'), asyncHandler(async (req, res) => {
  const window = z.coerce.number().int().min(5).max(360).default(60).parse(req.query.window ?? 60)
  ok(res, await getEndpoint(param(req), window))
}))

/* ---------------------------------------------------------------- Incidents */

api.get('/incidents', requirePermission('incidents:view'), asyncHandler(async (req, res) => {
  const query = z.object({
    ...paging.shape,
    status: z.enum(INCIDENT_STATUSES).optional(),
    severity: severity.optional(),
    q: z.string().trim().max(80).optional(),
    active: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  }).parse(req.query)
  ok(res, await listIncidents(query))
}))

api.post('/incidents', requirePermission('incidents:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({
    title: z.string().trim().min(4).max(140),
    description: z.string().trim().min(4).max(2000),
    severity,
    serviceIds: z.array(z.string().max(40)).max(10).optional(),
    institutionIds: z.array(z.string().max(40)).max(10).optional(),
  }).parse(req.body)
  ok(res, await createIncident(body, requireUser(req), req), 201)
}))

api.get('/incidents/:id', requirePermission('incidents:view'), asyncHandler(async (req, res) => {
  ok(res, await getIncident(param(req)))
}))

api.patch('/incidents/:id', requirePermission('incidents:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({
    title: z.string().trim().min(4).max(140).optional(),
    rootCause: z.string().trim().max(2000).optional(),
    rootCauseConfirmed: z.boolean().optional(),
    preventiveAction: z.string().trim().max(2000).optional(),
    team: z.string().trim().max(60).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to update.' }).parse(req.body)
  ok(res, await updateDetails(param(req), body, requireUser(req), req))
}))

api.post('/incidents/:id/status', requirePermission('incidents:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ status: z.enum(INCIDENT_STATUSES), note: z.string().trim().max(2000).optional() }).parse(req.body)
  ok(res, await changeStatus(param(req), body, requireUser(req), req))
}))

api.post('/incidents/:id/assign', requirePermission('incidents:assign'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ assigneeId: z.string().max(40).nullable(), team: z.string().trim().max(60).optional() }).parse(req.body)
  ok(res, await assignIncident(param(req), body, requireUser(req), req))
}))

api.post('/incidents/:id/severity', requirePermission('incidents:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ severity, reason: z.string().trim().max(500).optional() }).parse(req.body)
  ok(res, await changeSeverity(param(req), body, requireUser(req), req))
}))

api.post('/incidents/:id/notes', requirePermission('incidents:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ message: z.string().trim().min(2).max(2000) }).parse(req.body)
  ok(res, await addNote(param(req), body, requireUser(req), req), 201)
}))

api.post('/incidents/:id/resolve', requirePermission('incidents:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ resolution: z.string().trim().max(2000), rootCause: z.string().trim().max(2000).optional(), preventiveAction: z.string().trim().max(2000).optional() }).parse(req.body)
  ok(res, await resolveIncident(param(req), body, requireUser(req), req))
}))

api.post('/incidents/:id/reopen', requirePermission('incidents:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(4).max(1000) }).parse(req.body)
  ok(res, await reopenIncident(param(req), body, requireUser(req), req))
}))

api.post('/incidents/:id/rca', requirePermission('incidents:manage'), rateLimit({ windowMs: 60_000, max: 20, prefix: 'rca' }), asyncHandler(async (req, res) => {
  ok(res, await rerunRca(param(req), requireUser(req), req))
}))

/* ---------------------------------------------------------------- Anomalies */

api.get('/anomalies', requirePermission('anomalies:view'), asyncHandler(async (req, res) => {
  const query = z.object({
    ...paging.shape,
    status: z.enum(['DETECTED', 'REVIEW', 'CONFIRMED', 'DISMISSED', 'RESOLVED']).optional(),
    type: z.enum(ANOMALY_TYPES).optional(),
    severity: severity.optional(),
    q: z.string().trim().max(80).optional(),
  }).parse(req.query)
  ok(res, await listAnomalies(query))
}))

api.get('/anomalies/:id', requirePermission('anomalies:view'), asyncHandler(async (req, res) => {
  ok(res, await getAnomaly(param(req)))
}))

api.patch('/anomalies/:id', requirePermission('anomalies:review'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ status: z.enum(['REVIEW', 'CONFIRMED', 'DISMISSED', 'RESOLVED']), note: z.string().trim().max(1000).optional() }).parse(req.body)
  ok(res, await updateAnomaly(param(req), body, requireUser(req), req))
}))

/* ---------------------------------------------------------------- Analytics */

async function merchantAnalytics(range: ReturnType<typeof resolveRange>) {
  const rows = await prisma.$queryRaw<Array<{ id: string; name: string; category: string; total: number; failed: number; value: number; average: number }>>`
    SELECT m.id, m.name, m.category, COUNT(t.id)::int AS total, COUNT(t.id) FILTER (WHERE t.status = 'FAILED')::int AS failed,
      COALESCE(SUM(t.amount), 0)::float AS value, COALESCE(AVG(t.amount), 0)::float AS average
    FROM "Merchant" m LEFT JOIN "Transaction" t ON t."merchantId" = m.id AND t."createdAt" >= ${range.from} AND t."createdAt" <= ${range.to}
    GROUP BY m.id ORDER BY value DESC`
  const anomalies = await prisma.anomaly.groupBy({ by: ['merchantId'], _count: { _all: true }, where: { merchantId: { not: null }, detectedAt: { gte: range.from, lte: range.to } } })
  return rows.map((row) => ({ id: row.id, name: row.name, category: row.category, transactions: row.total, value: row.value, failureRate: row.total ? (row.failed / row.total) * 100 : 0, average: row.average, anomalies: anomalies.find((item) => item.merchantId === row.id)?._count._all ?? 0 }))
}

async function methodAnalytics(range: ReturnType<typeof resolveRange>) {
  const rows = await prisma.$queryRaw<Array<{ method: string; total: number; failed: number; success: number; value: number; latency: number }>>`
    SELECT "paymentMethod"::text AS method, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
      COUNT(*) FILTER (WHERE status IN ('SUCCESS', 'SETTLED'))::int AS success, COALESCE(SUM(amount), 0)::float AS value, AVG("responseTimeMs")::float AS latency
    FROM "Transaction" WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to} GROUP BY 1 ORDER BY total DESC`
  return rows.map((row) => ({ method: row.method, transactions: row.total, value: row.value, successRate: row.total ? (row.success / row.total) * 100 : 0, failureRate: row.total ? (row.failed / row.total) * 100 : 0, avgResponseMs: row.latency }))
}

api.get('/analytics', requirePermission('analytics:view'), asyncHandler(async (req, res) => {
  const range = rangeFrom(req.query, '7d')
  const [metrics, volume, institutions, merchants, methods, reasons, hourly] = await Promise.all([
    transactionAggregates(range),
    volumeSeries(range),
    institutionPerformance(range),
    merchantAnalytics(range),
    methodAnalytics(range),
    prisma.transaction.groupBy({ by: ['failureReason'], where: { status: 'FAILED', createdAt: { gte: range.from, lte: range.to } }, _count: { _all: true }, orderBy: { _count: { failureReason: 'desc' } } }),
    prisma.$queryRaw<Array<{ hour: number; total: number; failed: number }>>`
      SELECT EXTRACT(HOUR FROM "createdAt" + interval '345 minutes')::int AS hour, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
      FROM "Transaction" WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to} GROUP BY 1 ORDER BY 1`,
  ])
  ok(res, {
    range: { from: range.from.toISOString(), to: range.to.toISOString(), label: range.label, unit: range.unit },
    metrics,
    volume,
    institutions,
    merchants: merchants.slice(0, 25),
    paymentMethods: methods,
    failureReasons: reasons.map((row) => ({ reason: row.failureReason ?? 'UNSPECIFIED', count: row._count._all })),
    hourly: Array.from({ length: 24 }, (_, hour) => {
      const row = hourly.find((item) => item.hour === hour)
      return { hour, transactions: row?.total ?? 0, failureRate: row?.total ? (row.failed / row.total) * 100 : 0 }
    }),
  })
}))

api.get('/analytics/overview', requirePermission('analytics:view'), asyncHandler(async (req, res) => {
  const range = rangeFrom(req.query, '7d')
  const [metrics, volume, institutions] = await Promise.all([transactionAggregates(range), volumeSeries(range), institutionPerformance(range)])
  ok(res, { range, metrics, volume, institutions })
}))

api.get('/analytics/merchants', requirePermission('analytics:view'), asyncHandler(async (req, res) => {
  ok(res, await merchantAnalytics(rangeFrom(req.query, '7d')))
}))

api.get('/analytics/payments', requirePermission('analytics:view'), asyncHandler(async (req, res) => {
  ok(res, await methodAnalytics(rangeFrom(req.query, '7d')))
}))

/* ------------------------------------------------------------------ Reports */

api.get('/reports', requirePermission('reports:view'), asyncHandler(async (req, res) => {
  const query = z.object({ ...paging.shape, type: z.enum(REPORT_TYPES).optional() }).parse(req.query)
  ok(res, await listReports(query.page, query.limit, query.type))
}))

api.post('/reports', requirePermission('reports:generate'), idempotency, rateLimit({ windowMs: 60_000, max: 10, prefix: 'report' }), asyncHandler(async (req, res) => {
  const body = z.object({ type: z.enum(REPORT_TYPES), range: rangeKey.optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).parse(req.body)
  const user = requireUser(req)
  const window = body.from && body.to ? { from: body.from, to: body.to } : (() => {
    const range = resolveRange({ range: body.range ?? 'today' })
    return { from: range.from.toISOString(), to: range.to.toISOString() }
  })()
  ok(res, await generateReport({ type: body.type, ...window, userId: user.id, user, req }), 201)
}))

api.get('/reports/schedules', requirePermission('reports:view'), asyncHandler(async (_req, res) => {
  ok(res, await listSchedules())
}))

api.put('/reports/schedules/:cadence', requirePermission('settings:security'), asyncHandler(async (req, res) => {
  const cadence = z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).parse(req.params.cadence)
  const enabled = z.object({ enabled: z.boolean() }).parse(req.body).enabled
  ok(res, await updateSchedule(cadence, enabled, requireUser(req), req))
}))

api.get('/reports/:id', requirePermission('reports:view'), asyncHandler(async (req, res) => {
  const row = await getReport(param(req))
  ok(res, { id: row.id, type: row.type, title: row.title, dateFrom: row.dateFrom, dateTo: row.dateTo, payload: row.payload, deliveryStatus: row.deliveryStatus, createdAt: row.createdAt })
}))

api.get('/reports/:id/download', requirePermission('reports:view'), asyncHandler(async (req, res) => {
  const format = z.enum(['pdf', 'csv', 'xlsx']).parse(req.query.format ?? 'pdf')
  const file = await renderReport(param(req), format)
  await writeAudit({ user: requireUser(req), action: 'DOWNLOADED_REPORT', resource: 'REPORT', resourceId: param(req), req, newValue: { format } })
  res.setHeader('Content-Type', file.type)
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
  res.send(file.body)
}))

api.delete('/reports/:id', requirePermission('reports:delete'), asyncHandler(async (req, res) => {
  await deleteReport(param(req), requireUser(req), req)
  ok(res, { deleted: true })
}))

/* ------------------------------------------- Reconciliation and settlements */

api.get('/reconciliation', requirePermission('reconciliation:view'), asyncHandler(async (req, res) => {
  const query = z.object({ ...paging.shape, status: z.enum(['MATCHED', 'MISMATCH', 'INVESTIGATING', 'RESOLVED']).optional() }).parse(req.query)
  const [runs, summary] = await Promise.all([listRuns(query), reconciliationSummary()])
  ok(res, { ...runs, summary })
}))

api.post('/reconciliation/run', requirePermission('reconciliation:run'), idempotency, rateLimit({ windowMs: 60_000, max: 10, prefix: 'recon' }), asyncHandler(async (req, res) => {
  const body = z.object({ range: z.enum(['today', 'yesterday', '24h', '7d']).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), institution: z.string().regex(/^[A-Za-z]{3}$/).optional() }).parse(req.body ?? {})
  const window = body.from && body.to ? { from: new Date(body.from), to: new Date(body.to) } : resolveRange({ range: body.range ?? 'today' })
  const institution = body.institution ? await prisma.institution.findUnique({ where: { code: body.institution.toUpperCase() } }) : null
  if (body.institution && !institution) throw notFound('Institution not found.')
  ok(res, await runReconciliation({ from: window.from, to: window.to, institutionId: institution?.id, user: requireUser(req), req }), 201)
}))

api.get('/reconciliation/:id', requirePermission('reconciliation:view'), asyncHandler(async (req, res) => {
  const query = z.object({ ...paging.shape, issue: z.enum(['MISSING_AT_INSTITUTION', 'MISSING_ON_PLATFORM', 'AMOUNT_MISMATCH', 'NOT_SETTLED']).optional() }).parse(req.query)
  ok(res, await getRun(param(req), query))
}))

api.patch('/reconciliation/:id', requirePermission('reconciliation:run'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ status: z.enum(['INVESTIGATING', 'RESOLVED']), notes: z.string().trim().max(1000).optional() }).parse(req.body)
  ok(res, await updateRun(param(req), body, requireUser(req), req))
}))

api.get('/settlements', requirePermission('reconciliation:view'), asyncHandler(async (req, res) => {
  const query = z.object({ ...paging.shape, status: z.enum(['PENDING', 'PROCESSING', 'SETTLED', 'DELAYED', 'FAILED']).optional() }).parse(req.query)
  ok(res, await listSettlements(query))
}))

/* --------------------------------------------------------- Operational jobs */

api.get('/jobs', requirePermission('jobs:view'), asyncHandler(async (req, res) => {
  const query = z.object({ ...paging.shape, type: z.enum(JOB_TYPES).optional(), status: z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']).optional() }).parse(req.query)
  const [runs, catalog] = await Promise.all([listJobs(query), jobCatalog()])
  ok(res, { ...runs, catalog })
}))

api.post('/jobs/:type/run', requirePermission('jobs:run'), idempotency, rateLimit({ windowMs: 60_000, max: 20, prefix: 'jobs' }), asyncHandler(async (req, res) => {
  const type = z.enum(JOB_TYPES).parse(req.params.type)
  const body = z.object({ range: z.enum(['today', 'yesterday']).optional() }).parse(req.body ?? {})
  const user = requireUser(req)
  ok(res, await triggerJob(type, { range: body.range, triggeredBy: user.email, user, req }), 202)
}))

api.get('/jobs/:id', requirePermission('jobs:view'), asyncHandler(async (req, res) => {
  ok(res, await getJob(param(req)))
}))

/* ------------------------------------------------------------- Data quality */

api.get('/data-quality', requirePermission('dataquality:view'), asyncHandler(async (_req, res) => {
  ok(res, await dataQualityOverview())
}))

api.post('/data-quality/scan', requirePermission('dataquality:manage'), rateLimit({ windowMs: 60_000, max: 6, prefix: 'dq' }), asyncHandler(async (req, res) => {
  const result = await runDataQualityScan()
  await writeAudit({ user: requireUser(req), action: 'RAN_DATA_QUALITY_SCAN', resource: 'DATA_QUALITY', req, newValue: { total: result.total, issues: result.failed } })
  ok(res, await dataQualityOverview())
}))

api.get('/data-quality/:id/records', requirePermission('dataquality:view'), asyncHandler(async (req, res) => {
  ok(res, await affectedRecords(param(req), paging.parse(req.query)))
}))

api.patch('/data-quality/:id', requirePermission('dataquality:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ status: z.enum(['OPEN', 'INVESTIGATING', 'RESOLVED']), note: z.string().trim().max(1000).optional() }).parse(req.body)
  ok(res, await updateIssue(param(req), body, requireUser(req), req))
}))

/* ------------------------------------------------------- Audit and alerts */

const auditQuery = z.object({
  ...paging.shape,
  q: z.string().trim().max(80).optional(),
  action: z.string().trim().max(60).optional(),
  resource: z.string().trim().max(40).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

function auditWhere(query: z.infer<typeof auditQuery>) {
  return {
    ...(query.action ? { action: query.action } : {}),
    ...(query.resource ? { resource: query.resource } : {}),
    ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
    ...(query.q ? { OR: [{ actorEmail: { contains: query.q, mode: 'insensitive' as const } }, { resourceId: { contains: query.q, mode: 'insensitive' as const } }, { action: { contains: query.q, mode: 'insensitive' as const } }] } : {}),
  }
}

api.get('/audit-logs', requirePermission('audit:view'), asyncHandler(async (req, res) => {
  const query = auditQuery.parse(req.query)
  const where = auditWhere(query)
  const [total, rows, actions, resources] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
    prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
    prisma.auditLog.findMany({ distinct: ['resource'], select: { resource: true }, orderBy: { resource: 'asc' } }),
  ])
  ok(res, { ...pageOf(rows, total, query.page, query.limit), filters: { actions: actions.map((row) => row.action), resources: resources.map((row) => row.resource) } })
}))

api.get('/audit-logs/export', requirePermission('audit:view'), rateLimit({ windowMs: 60_000, max: 10, prefix: 'export' }), asyncHandler(async (req, res) => {
  const query = auditQuery.parse(req.query)
  const rows = await prisma.auditLog.findMany({ where: auditWhere(query), orderBy: { createdAt: 'desc' }, take: 10000 })
  const csv = toCsv(['timestamp', 'actor', 'action', 'resource', 'resourceId', 'ipAddress', 'userAgent', 'previousValue', 'newValue'], rows.map((row) => [row.createdAt.toISOString(), row.actorEmail, row.action, row.resource, row.resourceId, row.ipAddress, row.userAgent, row.previousValue ? JSON.stringify(row.previousValue) : null, row.newValue ? JSON.stringify(row.newValue) : null]))
  await writeAudit({ user: requireUser(req), action: 'EXPORTED_AUDIT_LOG', resource: 'AUDIT_LOG', req, newValue: { rows: rows.length } })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="finopsx-audit-log.csv"')
  res.send(`\uFEFF${csv}`)
}))

api.get('/notifications', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const query = z.object({ ...paging.shape, unread: z.enum(['true', 'false']).transform((value) => value === 'true').optional() }).parse(req.query)
  const where = { userId: user.id, ...(query.unread ? { read: false } : {}) }
  const [total, rows, unread] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
    prisma.notification.count({ where: { userId: user.id, read: false } }),
  ])
  ok(res, { ...pageOf(rows, total, query.page, query.limit), unread })
}))

api.patch('/notifications/:id/read', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const result = await prisma.notification.updateMany({ where: { id: param(req), userId: user.id }, data: { read: true } })
  if (!result.count) throw notFound('Notification not found.')
  ok(res, { read: true })
}))

api.post('/notifications/read-all', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const result = await prisma.notification.updateMany({ where: { userId: user.id, read: false }, data: { read: true } })
  ok(res, { read: true, updated: result.count })
}))

/* -------------------------------------------------------- Users and settings */

api.get('/users', requirePermission('users:manage'), asyncHandler(async (req, res) => {
  const query = z.object({ ...paging.shape, q: z.string().trim().max(80).optional() }).parse(req.query)
  ok(res, await listUsers(query.page, query.limit, query.q))
}))

api.get('/engineers', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  if (!can(user.role, 'incidents:assign') && !can(user.role, 'users:manage')) throw forbidden()
  const rows = await prisma.user.findMany({
    where: { status: 'ACTIVE', role: { name: { in: ['ENGINEER', 'OPERATIONS_MANAGER', 'SUPER_ADMIN'] } } },
    select: { id: true, name: true, email: true, role: { select: { name: true } } },
    orderBy: { name: 'asc' },
  })
  ok(res, rows.map((row) => ({ id: row.id, name: row.name, email: row.email, role: row.role.name })))
}))

api.post('/users', requirePermission('users:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(80), email: z.string().trim().email().max(254), role: ROLE_ENUM, password: password.optional() }).parse(req.body)
  ok(res, await createUser(body, requireUser(req), req), 201)
}))

api.patch('/users/:id', requirePermission('users:manage'), asyncHandler(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(80).optional(), role: ROLE_ENUM.optional(), status: z.enum(['ACTIVE', 'LOCKED', 'DEACTIVATED']).optional() }).parse(req.body)
  ok(res, await updateUser(param(req), body, requireUser(req), req))
}))

api.post('/users/:id/reset-password', requirePermission('users:manage'), idempotency, asyncHandler(async (req, res) => {
  ok(res, await resetUserPassword(param(req), requireUser(req), req))
}))

api.get('/settings', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const row = await prisma.user.findUnique({ where: { id: user.id }, include: { role: true } })
  if (!row) throw notFound()
  const [thresholds, simulator, services] = await Promise.all([getThresholds(), simulatorStatus(), prisma.service.count()])
  ok(res, {
    profile: toPublicUser(row),
    thresholds: can(user.role, 'settings:thresholds') ? thresholds : null,
    simulator: can(user.role, 'simulator:control') ? simulator : { warning: simulator.warning },
    ai: {
      provider: env.aiEnabled ? 'openai' : 'mock',
      message: env.aiEnabled ? 'OpenAI-compatible provider configured. Answers are still grounded in FinOpsX tool results.' : 'Answers come from the local FinOpsX analysis engine using live demo data.',
      model: env.aiEnabled ? env.aiModel : 'local',
    },
    email: env.emailEnabled ? 'SMTP configured.' : 'Email delivery is disabled in the demo environment.',
    services,
  })
}))

api.patch('/settings/profile', asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().trim().min(2).max(80).optional(),
    timezone: z.string().min(3).max(60).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    notifyIncidents: z.boolean().optional(),
    notifyAnomalies: z.boolean().optional(),
    notifyReports: z.boolean().optional(),
    notifySecurity: z.boolean().optional(),
    currentPassword: z.string().max(128).optional(),
    newPassword: password.optional(),
  }).parse(req.body)
  ok(res, await updateProfile(requireUser(req).id, body, req))
}))

api.patch('/settings/thresholds', requirePermission('settings:thresholds'), asyncHandler(async (req, res) => {
  const body = z.object({
    highValueAmount: z.number().int().positive().max(100_000_000).optional(),
    failureRatePct: z.number().positive().max(100).optional(),
    latencyMs: z.number().int().min(100).max(60_000).optional(),
    availabilityPct: z.number().positive().max(100).optional(),
    volumeAnomalyPct: z.number().positive().max(1000).optional(),
    repeatedFailureCount: z.number().int().min(2).max(1000).optional(),
    dedupWindowMinutes: z.number().int().min(5).max(1440).optional(),
    rpmGate: z.number().int().min(1).max(10000).optional(),
    consecutiveLatencyChecks: z.number().int().min(1).max(30).optional(),
  }).strict().parse(req.body)
  ok(res, await updateThresholds(body, requireUser(req), req))
}))

api.get('/search', asyncHandler(async (req, res) => {
  const q = z.string().trim().min(2).max(80).parse(req.query.q)
  const user = requireUser(req)
  const [transactions, incidents, institutions, anomalies, users] = await Promise.all([
    can(user.role, 'transactions:view') ? prisma.transaction.findMany({ where: { OR: [{ transactionId: { contains: q, mode: 'insensitive' } }, { correlationId: { contains: q, mode: 'insensitive' } }, { customerId: { contains: q, mode: 'insensitive' } }] }, take: 5, include: { institution: true } }) : [],
    can(user.role, 'incidents:view') ? prisma.incident.findMany({ where: { OR: [{ publicId: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }] }, take: 5 }) : [],
    can(user.role, 'institutions:view') ? prisma.institution.findMany({ where: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] }, take: 5 }) : [],
    can(user.role, 'anomalies:view') ? prisma.anomaly.findMany({ where: { OR: [{ publicId: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }] }, take: 5 }) : [],
    can(user.role, 'users:manage') ? prisma.user.findMany({ where: { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] }, take: 5, include: { role: true } }) : [],
  ])
  ok(res, {
    transactions: transactions.map((row) => ({ id: row.transactionId, status: row.status, amount: num(row.amount), institution: row.institution.name, link: `/transactions/${row.transactionId}` })),
    incidents: incidents.map((row) => ({ id: row.publicId, title: row.title, status: row.status, link: `/incidents/${row.publicId}` })),
    institutions: institutions.map((row) => ({ id: row.code, name: row.name, status: row.status, link: `/institutions/${row.id}` })),
    anomalies: anomalies.map((row) => ({ id: row.publicId, title: row.title, status: row.status, link: `/anomalies?focus=${row.publicId}` })),
    users: users.map((row) => ({ id: row.email, name: row.name, role: row.role.name, link: '/users' })),
  })
}))

/* ---------------------------------------------------------------------- AI */

api.post('/ai/chat', requirePermission('ai:use'), rateLimit({ windowMs: 60_000, max: 30, prefix: 'ai' }), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ message: z.string().trim().min(2).max(2000), conversationId: z.string().max(40).optional() }).parse(req.body)
  const user = requireUser(req)
  const conversation = body.conversationId
    ? await prisma.aiConversation.findFirst({ where: { id: body.conversationId, userId: user.id } })
    : await prisma.aiConversation.create({ data: { userId: user.id, title: body.message.slice(0, 80) } })
  if (!conversation) throw notFound('Conversation not found.')
  await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: 'user', content: body.message } })
  const answer = await answerQuestion(body.message, { id: user.id, role: user.role })
  const saved = await prisma.aiMessage.create({
    data: { conversationId: conversation.id, role: 'assistant', content: answer.content, tool: answer.tool, actions: answer.actions as unknown as Prisma.InputJsonValue },
  })
  await prisma.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } })
  ok(res, { conversationId: conversation.id, message: saved, table: answer.table, actions: answer.actions, reportId: answer.reportId, provider: answer.provider, status: answer.status, notice: answer.notice })
}))

api.get('/ai/conversations', requirePermission('ai:use'), asyncHandler(async (req, res) => {
  ok(res, await prisma.aiConversation.findMany({ where: { userId: requireUser(req).id }, orderBy: { updatedAt: 'desc' }, take: 30 }))
}))

api.post('/ai/conversations', requirePermission('ai:use'), asyncHandler(async (req, res) => {
  const title = z.object({ title: z.string().trim().min(1).max(80).optional() }).parse(req.body ?? {}).title ?? 'New conversation'
  ok(res, await prisma.aiConversation.create({ data: { userId: requireUser(req).id, title } }), 201)
}))

api.get('/ai/conversations/:id', requirePermission('ai:use'), asyncHandler(async (req, res) => {
  const row = await prisma.aiConversation.findFirst({ where: { id: param(req), userId: requireUser(req).id }, include: { messages: { orderBy: { createdAt: 'asc' } } } })
  if (!row) throw notFound('Conversation not found.')
  ok(res, row)
}))

api.patch('/ai/conversations/:id', requirePermission('ai:use'), asyncHandler(async (req, res) => {
  const title = z.object({ title: z.string().trim().min(1).max(80) }).parse(req.body).title
  const existing = await prisma.aiConversation.findFirst({ where: { id: param(req), userId: requireUser(req).id } })
  if (!existing) throw notFound('Conversation not found.')
  ok(res, await prisma.aiConversation.update({ where: { id: existing.id }, data: { title } }))
}))

api.delete('/ai/conversations/:id', requirePermission('ai:use'), asyncHandler(async (req, res) => {
  const existing = await prisma.aiConversation.findFirst({ where: { id: param(req), userId: requireUser(req).id } })
  if (!existing) throw notFound('Conversation not found.')
  await prisma.aiConversation.delete({ where: { id: existing.id } })
  ok(res, { deleted: true })
}))

/** Ask Your Data: natural language or an edited structured query; both are validated against the whitelist before execution. */
api.post('/ai/query', requirePermission('askdata:use'), rateLimit({ windowMs: 60_000, max: 30, prefix: 'askdata' }), asyncHandler(async (req, res) => {
  const body = z.union([
    z.object({ question: z.string().trim().min(3).max(500) }).strict(),
    z.object({ query: structuredQuerySchema }).strict(),
  ]).parse(req.body)
  const user = requireUser(req)
  const started = Date.now()
  let query
  let interpretation: string[] = []
  const question = 'question' in body ? body.question : '(structured query)'
  if ('question' in body) {
    const parsed = parseQuestion(body.question)
    if (!parsed.ok) {
      await prisma.aiQuery.create({ data: { userId: user.id, kind: 'ask-data', question, status: parsed.reason === 'refused' ? 'REFUSED' : 'UNSUPPORTED', durationMs: Date.now() - started } })
      if (parsed.reason === 'refused') throw unprocessable(parsed.message)
      ok(res, { supported: false, message: parsed.message, query: null, interpretation: [], columns: [], rows: [], rowLinks: [], total: 0 })
      return
    }
    query = parsed.query
    interpretation = parsed.interpretation
  } else {
    query = body.query
  }
  const result = await executeQuery(query, user.role)
  await prisma.aiQuery.create({ data: { userId: user.id, kind: 'ask-data', question, intent: query.entity, structuredQuery: query, resultCount: result.total, status: result.total ? 'ANSWERED' : 'NO_DATA', durationMs: Date.now() - started } })
  ok(res, { supported: true, query, interpretation, ...result, message: result.total ? result.summary : `I don't have enough data to answer that. ${result.summary}` })
}))

api.post('/ai/query/export', requirePermission('askdata:use'), rateLimit({ windowMs: 60_000, max: 10, prefix: 'export' }), asyncHandler(async (req, res) => {
  const { query } = z.object({ query: structuredQuerySchema }).strict().parse(req.body)
  const user = requireUser(req)
  const result = await executeQuery({ ...query, limit: 200 }, user.role, { maxRows: query.mode === 'list' ? 5000 : 200 })
  await writeAudit({ user, action: 'EXPORTED_QUERY', resource: 'AI_QUERY', req, newValue: { query, rows: result.rows.length } })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="finopsx-query.csv"')
  res.send(`\uFEFF${toCsv(result.columns, result.rows)}`)
}))

/* --------------------------------------------------------------- Simulator */

api.get('/simulator/status', requirePermission('simulator:control'), asyncHandler(async (_req, res) => ok(res, await simulatorStatus())))
api.get('/simulator/config', requirePermission('simulator:control'), asyncHandler(async (_req, res) => ok(res, await simulatorStatus())))

api.post('/simulator/start', requirePermission('simulator:control'), idempotency, asyncHandler(async (req, res) => {
  await startSimulator()
  await writeAudit({ user: requireUser(req), action: 'SIMULATOR_STARTED', resource: 'SIMULATOR', req })
  ok(res, await simulatorStatus())
}))

api.post('/simulator/stop', requirePermission('simulator:control'), asyncHandler(async (req, res) => {
  await stopSimulator()
  await writeAudit({ user: requireUser(req), action: 'SIMULATOR_STOPPED', resource: 'SIMULATOR', req })
  ok(res, await simulatorStatus())
}))

api.post('/simulator/reset', requirePermission('simulator:control'), asyncHandler(async (req, res) => {
  const before = await simulatorStatus()
  await resetSimulator()
  await writeAudit({ user: requireUser(req), action: 'SIMULATOR_RESET', resource: 'SIMULATOR', req, previousValue: { tpm: before.tpm, scenario: before.scenario } })
  ok(res, await simulatorStatus())
}))

api.patch('/simulator/config', requirePermission('simulator:control'), asyncHandler(async (req, res) => {
  const body = z.object({
    tpm: z.number().int().min(1).max(600).optional(),
    successRate: z.number().min(0).max(1).optional(),
    failureRate: z.number().min(0).max(1).optional(),
    pendingRate: z.number().min(0).max(1).optional(),
    highValueRate: z.number().min(0).max(0.5).optional(),
    anomalyRate: z.number().min(0).max(1).optional(),
    averageAmount: z.number().int().min(50).max(1_000_000).optional(),
  }).strict().parse(req.body)
  const before = await simulatorStatus()
  const failure = body.failureRate ?? before.failureRate
  const pending = body.pendingRate ?? before.pendingRate
  if (failure + pending > 0.95) throw unprocessable('Failure and pending rates together must stay below 95% so some payments succeed.', { failureRate: failure, pendingRate: pending })
  await updateSimulator({ ...body, successRate: Number((1 - failure - pending).toFixed(4)) })
  await writeAudit({ user: requireUser(req), action: 'SIMULATOR_CONFIGURED', resource: 'SIMULATOR', req, previousValue: { tpm: before.tpm, failureRate: before.failureRate, pendingRate: before.pendingRate, averageAmount: before.averageAmount, highValueRate: before.highValueRate }, newValue: body })
  ok(res, await simulatorStatus())
}))

api.post('/simulator/scenario', requirePermission('simulator:control'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ name: z.enum(SCENARIOS), intensity: z.number().min(0.5).max(2).optional() }).parse(req.body)
  const current = await simulatorStatus()
  if (current.scenario && current.scenario !== body.name) throw unprocessable(`Scenario ${current.scenarioLabel} is already running. Resolve it first.`)
  const status = await startScenario(body.name, body.intensity ?? 1)
  await writeAudit({ user: requireUser(req), action: 'SCENARIO_STARTED', resource: 'SIMULATOR', resourceId: body.name, req, newValue: { intensity: body.intensity ?? 1 } })
  ok(res, status)
}))

api.post('/simulator/scenario/resolve', requirePermission('simulator:control'), asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const before = await simulatorStatus()
  if (!before.scenario) throw unprocessable('No scenario is running.')
  const status = await resolveScenario({ actorEmail: user.email })
  await writeAudit({ user, action: 'SCENARIO_RESOLVED', resource: 'SIMULATOR', resourceId: before.scenario, req })
  ok(res, status)
}))

api.post('/dev/reset-demo', asyncHandler(async (req, res) => {
  if (env.isProd) throw notFound('Feature unavailable in this environment.')
  const user = requireUser(req)
  if (user.role !== 'SUPER_ADMIN') throw forbidden()
  ok(res, { message: 'Use npm run db:seed to reseed. This endpoint confirms the admin is authorized to reset demo data.', authorized: true })
}))
