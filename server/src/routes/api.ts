import { Router } from 'express'
import { z } from 'zod'
import { can } from '@finopsx/shared'
import { env } from '../config/env.js'
import { AppError, forbidden, notFound } from '../lib/errors.js'
import { asyncHandler, ok, pageOf, requirePermission, requireUser } from '../lib/http.js'
import { prisma, num } from '../lib/prisma.js'
import { redisState } from '../lib/redis.js'
import { authenticate, idempotency, rateLimit, validate } from '../middleware/common.js'
import { answerQuestion } from '../services/ai/assistant.js'
import { demoAccounts, forgotPassword, login, logout, refresh, resetPassword, toPublicUser } from '../services/authService.js'
import { listAnomalies, updateAnomaly } from '../services/anomalyService.js'
import { writeAudit } from '../services/audit.js'
import { systemHealth } from '../services/healthService.js'
import { createIncident, getIncident, listIncidents, updateIncident } from '../services/incidentService.js'
import { dashboardSummary, institutionPerformance, transactionAggregates, volumeSeries } from '../services/metricsService.js'
import { deleteReport, generateReport, getReport, listReports, listSchedules, renderReport, updateSchedule } from '../services/reportService.js'
import { getThresholds } from '../services/thresholds.js'
import { getTransaction, investigateTransaction, listTransactions } from '../services/transactionService.js'
import { createUser, listUsers, resetUserPassword, updateProfile, updateThresholds, updateUser } from '../services/userService.js'
import { resolveRange } from '../utils/range.js'
import {
  resetSimulator,
  resolveScenario,
  simulatorStatus,
  startScenario,
  startSimulator,
  stopSimulator,
  updateSimulator,
} from '../simulator/engine.js'
import { openApi } from '../openapi.js'
import swaggerUi from 'swagger-ui-express'

const password = z.string().min(8).regex(/[a-z]/).regex(/[A-Z]/).regex(/\d/)
const paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
})

export const api = Router()

api.use('/docs', swaggerUi.serve, swaggerUi.setup(openApi))

api.get('/auth/demo-accounts', (_req, res) => {
  ok(res, { accounts: demoAccounts(), production: env.isProd })
})

api.post('/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 10, prefix: 'auth' }), validate(z.object({
  body: z.object({ email: z.string().email(), password: z.string().min(1), rememberMe: z.boolean().optional() }),
})), asyncHandler(async (req, res) => {
  const body = (req as typeof req & { validated: { body: { email: string; password: string; rememberMe?: boolean } } }).validated.body
  ok(res, await login(body, req))
}))

api.post('/auth/refresh', asyncHandler(async (req, res) => {
  const token = z.object({ refreshToken: z.string().min(10) }).parse(req.body).refreshToken
  ok(res, await refresh(token, req))
}))

api.post('/auth/forgot-password', rateLimit({ windowMs: 15 * 60_000, max: 10, prefix: 'forgot' }), asyncHandler(async (req, res) => {
  const email = z.object({ email: z.string().email() }).parse(req.body).email
  ok(res, await forgotPassword(email))
}))

api.post('/auth/reset-password', asyncHandler(async (req, res) => {
  const body = z.object({ token: z.string().min(10), password }).parse(req.body)
  await resetPassword(body.token, body.password, req)
  ok(res, { message: 'Password updated. Sign in with the new password.' })
}))

api.use(authenticate)
api.use(rateLimit({ windowMs: 60_000, max: 100, prefix: 'api' }))

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

api.get('/dashboard/summary', requirePermission('dashboard:view'), asyncHandler(async (req, res) => {
  ok(res, await dashboardSummary({ range: String(req.query.range ?? '24h'), from: optionalString(req.query.from), to: optionalString(req.query.to) }))
}))

api.get('/dashboard/volume', requirePermission('dashboard:view'), asyncHandler(async (req, res) => {
  ok(res, await volumeSeries(resolveRange({ range: String(req.query.range ?? '24h'), from: optionalString(req.query.from), to: optionalString(req.query.to) })))
}))

api.get('/dashboard/outcomes', requirePermission('dashboard:view'), asyncHandler(async (req, res) => {
  const metrics = await transactionAggregates(resolveRange({ range: String(req.query.range ?? '24h'), from: optionalString(req.query.from), to: optionalString(req.query.to) }))
  ok(res, {
    success: metrics.successRate,
    failed: metrics.failureRate,
    pending: metrics.pendingRate,
    counts: metrics.counts,
  })
}))

api.get('/transactions', requirePermission('transactions:view'), asyncHandler(async (req, res) => {
  const query = z.object({
    ...paging.shape,
    q: z.string().optional(),
    status: z.string().optional(),
    institutionId: z.string().optional(),
    merchantId: z.string().optional(),
    paymentMethod: z.string().optional(),
    minAmount: z.coerce.number().optional(),
    maxAmount: z.coerce.number().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    minRisk: z.coerce.number().optional(),
    failureReason: z.string().optional(),
    sort: z.string().optional(),
    dir: z.string().optional(),
    preset: z.string().optional(),
    suspicious: z.coerce.boolean().optional(),
    highValue: z.coerce.boolean().optional(),
  }).parse(req.query)
  ok(res, await listTransactions(query))
}))

api.get('/transactions/:id', requirePermission('transactions:view'), asyncHandler(async (req, res) => {
  ok(res, await getTransaction(param(req)))
}))

api.post('/transactions/:id/investigate', requirePermission('transactions:investigate'), idempotency, asyncHandler(async (req, res) => {
  ok(res, await investigateTransaction(param(req), requireUser(req), req))
}))

api.get('/institutions', requirePermission('institutions:view'), asyncHandler(async (req, res) => {
  const range = resolveRange({ range: String(req.query.range ?? '30d') })
  ok(res, await institutionPerformance(range))
}))

api.get('/institutions/:id', requirePermission('institutions:view'), asyncHandler(async (req, res) => {
  const range = resolveRange({ range: String(req.query.range ?? '7d') })
  const rows = await institutionPerformance(range)
  const row = rows.find((item) => item.id === param(req) || item.code === param(req))
  if (!row) throw notFound('Institution not found.')
  const reasons = await prisma.transaction.groupBy({
    by: ['failureReason'],
    where: { institutionId: row.id, status: 'FAILED', failureReason: { not: null }, createdAt: { gte: range.from, lte: range.to } },
    _count: { _all: true },
    orderBy: { _count: { failureReason: 'desc' } },
    take: 6,
  })
  const volume = await volumeSeries(range)
  ok(res, {
    ...row,
    topFailure: reasons[0]?.failureReason ?? null,
    failureReasons: reasons.map((reason) => ({ reason: reason.failureReason, count: reason._count._all })),
    volume,
  })
}))

api.get('/system/health', requirePermission('system:view'), asyncHandler(async (_req, res) => {
  ok(res, await systemHealth())
}))

api.get('/incidents', requirePermission('incidents:view'), asyncHandler(async (req, res) => {
  const query = z.object({ ...paging.shape, status: z.string().optional(), severity: z.string().optional(), q: z.string().optional() }).parse(req.query)
  ok(res, await listIncidents(query))
}))

api.post('/incidents', requirePermission('incidents:manage'), idempotency, validate(z.object({
  body: z.object({
    title: z.string().min(4).max(140),
    description: z.string().min(4).max(2000),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    serviceIds: z.array(z.string()).optional(),
    institutionIds: z.array(z.string()).optional(),
  }),
})), asyncHandler(async (req, res) => {
  const body = (req as typeof req & { validated: { body: { title: string; description: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; serviceIds?: string[]; institutionIds?: string[] } } }).validated.body
  ok(res, await createIncident(body, requireUser(req), req), 201)
}))

api.get('/incidents/:id', requirePermission('incidents:view'), asyncHandler(async (req, res) => {
  ok(res, await getIncident(param(req)))
}))

api.patch('/incidents/:id', requirePermission('incidents:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({
    status: z.enum(['OPEN', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATING', 'RESOLVED', 'CLOSED']).optional(),
    assigneeId: z.string().nullable().optional(),
    rootCause: z.string().max(2000).optional(),
    resolution: z.string().max(2000).optional(),
    note: z.string().max(2000).optional(),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  }).parse(req.body)
  ok(res, await updateIncident(param(req), body, requireUser(req), req))
}))

api.get('/anomalies', requirePermission('anomalies:view'), asyncHandler(async (req, res) => {
  const query = z.object({ ...paging.shape, status: z.string().optional(), type: z.string().optional(), q: z.string().optional() }).parse(req.query)
  ok(res, await listAnomalies(query))
}))

api.patch('/anomalies/:id', requirePermission('anomalies:review'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ status: z.enum(['REVIEW', 'CONFIRMED', 'DISMISSED']), note: z.string().max(1000).optional() }).parse(req.body)
  ok(res, await updateAnomaly(param(req), body, requireUser(req), req))
}))

api.get('/analytics/overview', requirePermission('analytics:view'), asyncHandler(async (req, res) => {
  const range = resolveRange({ range: String(req.query.range ?? '7d'), from: optionalString(req.query.from), to: optionalString(req.query.to) })
  const [metrics, volume, institutions] = await Promise.all([
    transactionAggregates(range),
    volumeSeries(range),
    institutionPerformance(range),
  ])
  ok(res, { range, metrics, volume, institutions })
}))

api.get('/analytics/merchants', requirePermission('analytics:view'), asyncHandler(async (req, res) => {
  const range = resolveRange({ range: String(req.query.range ?? '7d') })
  const grouped = await prisma.transaction.groupBy({
    by: ['merchantId', 'status'],
    where: { createdAt: { gte: range.from, lte: range.to } },
    _count: { _all: true },
    _sum: { amount: true },
    _avg: { amount: true },
  })
  const merchants = await prisma.merchant.findMany()
  const anomalies = await prisma.anomaly.groupBy({ by: ['merchantId'], _count: { _all: true }, where: { merchantId: { not: null } } })
  const rows = merchants.map((merchant) => {
    const related = grouped.filter((row) => row.merchantId === merchant.id)
    const total = related.reduce((sum, row) => sum + row._count._all, 0)
    const failed = related.find((row) => row.status === 'FAILED')?._count._all ?? 0
    const value = related.reduce((sum, row) => sum + num(row._sum.amount), 0)
    return {
      id: merchant.id,
      name: merchant.name,
      category: merchant.category,
      transactions: total,
      value,
      failureRate: total ? (failed / total) * 100 : 0,
      average: related[0]?._avg.amount ? num(related[0]._avg.amount) : 0,
      anomalies: anomalies.find((item) => item.merchantId === merchant.id)?._count._all ?? 0,
    }
  }).sort((a, b) => b.value - a.value)
  ok(res, rows)
}))

api.get('/analytics/payments', requirePermission('analytics:view'), asyncHandler(async (req, res) => {
  const range = resolveRange({ range: String(req.query.range ?? '7d') })
  const rows = await prisma.transaction.groupBy({
    by: ['paymentMethod', 'status'],
    where: { createdAt: { gte: range.from, lte: range.to } },
    _count: { _all: true },
  })
  ok(res, rows)
}))

api.get('/reports', requirePermission('reports:view'), asyncHandler(async (req, res) => {
  const query = paging.parse(req.query)
  ok(res, await listReports(query.page, query.limit))
}))

api.post('/reports', requirePermission('reports:generate'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({
    type: z.enum(['DAILY_OPERATIONS', 'TRANSACTION_SUMMARY', 'INSTITUTION_PERFORMANCE', 'INCIDENT_REPORT', 'ANOMALY_REPORT', 'SYSTEM_HEALTH']),
    from: z.string().optional(),
    to: z.string().optional(),
  }).parse(req.body)
  const user = requireUser(req)
  ok(res, await generateReport({ ...body, userId: user.id, user, req }), 201)
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
  ok(res, { id: row.id, type: row.type, title: row.title, payload: row.payload, deliveryStatus: row.deliveryStatus, createdAt: row.createdAt })
}))

api.get('/reports/:id/download', requirePermission('reports:view'), asyncHandler(async (req, res) => {
  const format = z.enum(['pdf', 'csv', 'xlsx']).parse(req.query.format ?? 'pdf')
  const file = await renderReport(param(req), format)
  res.setHeader('Content-Type', file.type)
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
  res.send(file.body)
}))

api.delete('/reports/:id', requirePermission('reports:delete'), asyncHandler(async (req, res) => {
  await deleteReport(param(req), requireUser(req), req)
  ok(res, { deleted: true })
}))

api.get('/audit-logs', requirePermission('audit:view'), asyncHandler(async (req, res) => {
  const query = z.object({ ...paging.shape, q: z.string().optional(), action: z.string().optional() }).parse(req.query)
  const where = {
    ...(query.action ? { action: query.action } : {}),
    ...(query.q ? { OR: [{ actorEmail: { contains: query.q, mode: 'insensitive' as const } }, { resourceId: { contains: query.q, mode: 'insensitive' as const } }, { action: { contains: query.q, mode: 'insensitive' as const } }] } : {}),
  }
  const skip = (query.page - 1) * query.limit
  const [total, rows] = await prisma.$transaction([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: query.limit }),
  ])
  ok(res, pageOf(rows, total, query.page, query.limit))
}))

api.get('/notifications', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const rows = await prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 30 })
  const unread = rows.filter((row) => !row.read).length
  ok(res, { unread, items: rows })
}))

api.patch('/notifications/:id/read', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  await prisma.notification.updateMany({ where: { id: param(req), userId: user.id }, data: { read: true } })
  ok(res, { read: true })
}))

api.post('/notifications/read-all', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  await prisma.notification.updateMany({ where: { userId: user.id, read: false }, data: { read: true } })
  ok(res, { read: true })
}))

api.get('/users', requirePermission('users:manage'), asyncHandler(async (req, res) => {
  const query = z.object({ ...paging.shape, q: z.string().optional() }).parse(req.query)
  ok(res, await listUsers(query.page, query.limit, query.q))
}))

api.get('/engineers', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  if (!can(user.role, 'incidents:assign') && !can(user.role, 'users:manage')) throw forbidden()
  const rows = await prisma.user.findMany({ where: { role: { name: 'ENGINEER' }, status: 'ACTIVE' }, select: { id: true, name: true, email: true } })
  ok(res, rows)
}))

api.post('/users', requirePermission('users:manage'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    role: z.enum(['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ANALYST', 'ENGINEER', 'AUDITOR']),
    password: password.optional(),
  }).parse(req.body)
  ok(res, await createUser(body, requireUser(req), req), 201)
}))

api.patch('/users/:id', requirePermission('users:manage'), asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(2).optional(),
    role: z.enum(['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ANALYST', 'ENGINEER', 'AUDITOR']).optional(),
    status: z.enum(['ACTIVE', 'LOCKED', 'DEACTIVATED']).optional(),
  }).parse(req.body)
  ok(res, await updateUser(param(req), body, requireUser(req), req))
}))

api.post('/users/:id/reset-password', requirePermission('users:manage'), idempotency, asyncHandler(async (req, res) => {
  ok(res, await resetUserPassword(param(req), requireUser(req), req))
}))

api.get('/settings', asyncHandler(async (req, res) => {
  const user = requireUser(req)
  const row = await prisma.user.findUnique({ where: { id: user.id }, include: { role: true } })
  if (!row) throw notFound()
  const [thresholds, simulator, services] = await Promise.all([
    getThresholds(),
    simulatorStatus(),
    prisma.service.count(),
  ])
  ok(res, {
    profile: toPublicUser(row),
    thresholds: can(user.role, 'settings:thresholds') ? thresholds : null,
    simulator: can(user.role, 'simulator:control') ? simulator : { warning: simulator.warning },
    ai: {
      provider: env.aiEnabled ? 'openai' : 'mock',
      message: env.aiEnabled ? 'OpenAI-compatible provider configured.' : 'AI provider unavailable. Using local demo analysis.',
      model: env.aiEnabled ? env.aiModel : 'mock',
    },
    email: env.emailEnabled ? 'SMTP configured.' : 'Email delivery is disabled in demo environment.',
    services,
  })
}))

api.patch('/settings/profile', asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(2).optional(),
    timezone: z.string().min(3).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    notifyIncidents: z.boolean().optional(),
    notifyAnomalies: z.boolean().optional(),
    notifyReports: z.boolean().optional(),
    notifySecurity: z.boolean().optional(),
    currentPassword: z.string().optional(),
    newPassword: password.optional(),
  }).parse(req.body)
  ok(res, await updateProfile(requireUser(req).id, body, req))
}))

api.patch('/settings/thresholds', requirePermission('settings:thresholds'), asyncHandler(async (req, res) => {
  const body = z.object({
    highValueAmount: z.number().int().positive().optional(),
    failureRatePct: z.number().positive().max(100).optional(),
    latencyMs: z.number().int().positive().optional(),
    availabilityPct: z.number().positive().max(100).optional(),
    volumeAnomalyPct: z.number().positive().optional(),
    repeatedFailureCount: z.number().int().positive().optional(),
  }).parse(req.body)
  ok(res, await updateThresholds(body, requireUser(req), req))
}))

api.get('/search', asyncHandler(async (req, res) => {
  const q = z.string().min(2).parse(req.query.q)
  const user = requireUser(req)
  const [transactions, incidents, institutions, anomalies, users] = await Promise.all([
    can(user.role, 'transactions:view') ? prisma.transaction.findMany({ where: { OR: [{ transactionId: { contains: q, mode: 'insensitive' } }, { customerId: { contains: q, mode: 'insensitive' } }] }, take: 5, include: { institution: true } }) : [],
    can(user.role, 'incidents:view') ? prisma.incident.findMany({ where: { OR: [{ publicId: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }] }, take: 5 }) : [],
    can(user.role, 'institutions:view') ? prisma.institution.findMany({ where: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] }, take: 5 }) : [],
    can(user.role, 'anomalies:view') ? prisma.anomaly.findMany({ where: { OR: [{ publicId: { contains: q, mode: 'insensitive' } }, { title: { contains: q, mode: 'insensitive' } }] }, take: 5 }) : [],
    can(user.role, 'users:manage') ? prisma.user.findMany({ where: { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] }, take: 5, include: { role: true } }) : [],
  ])
  ok(res, {
    transactions: transactions.map((row) => ({ id: row.transactionId, status: row.status, amount: num(row.amount), institution: row.institution.name, link: `/transactions/${row.transactionId}` })),
    incidents: incidents.map((row) => ({ id: row.publicId, title: row.title, status: row.status, link: `/incidents/${row.publicId}` })),
    institutions: institutions.map((row) => ({ id: row.code, name: row.name, status: row.status, link: `/institutions/${row.id}` })),
    anomalies: anomalies.map((row) => ({ id: row.publicId, title: row.title, status: row.status, link: '/anomalies' })),
    users: users.map((row) => ({ id: row.email, name: row.name, role: row.role.name, link: '/users' })),
  })
}))

api.post('/ai/chat', requirePermission('ai:use'), rateLimit({ windowMs: 60_000, max: 30, prefix: 'ai' }), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({ message: z.string().min(2).max(2000), conversationId: z.string().optional() }).parse(req.body)
  const user = requireUser(req)
  const conversation = body.conversationId
    ? await prisma.aiConversation.findFirst({ where: { id: body.conversationId, userId: user.id } })
    : await prisma.aiConversation.create({ data: { userId: user.id, title: body.message.slice(0, 80) } })
  if (!conversation) throw notFound('Conversation not found.')
  await prisma.aiMessage.create({ data: { conversationId: conversation.id, role: 'user', content: body.message } })
  const answer = await answerQuestion(body.message, user.id, env.aiEnabled ? 'openai' : 'mock')
  const saved = await prisma.aiMessage.create({
    data: { conversationId: conversation.id, role: 'assistant', content: answer.content, tool: answer.tool },
  })
  await prisma.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } })
  ok(res, { conversationId: conversation.id, message: saved, table: answer.table, reportId: answer.reportId, provider: answer.provider, notice: answer.notice ?? null })
}))

api.get('/ai/conversations', requirePermission('ai:use'), asyncHandler(async (req, res) => {
  const rows = await prisma.aiConversation.findMany({ where: { userId: requireUser(req).id }, orderBy: { updatedAt: 'desc' }, take: 30 })
  ok(res, rows)
}))

api.post('/ai/conversations', requirePermission('ai:use'), asyncHandler(async (req, res) => {
  const title = z.object({ title: z.string().min(1).max(80).optional() }).parse(req.body).title ?? 'New conversation'
  const row = await prisma.aiConversation.create({ data: { userId: requireUser(req).id, title } })
  ok(res, row, 201)
}))

api.get('/ai/conversations/:id', requirePermission('ai:use'), asyncHandler(async (req, res) => {
  const row = await prisma.aiConversation.findFirst({
    where: { id: param(req), userId: requireUser(req).id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })
  if (!row) throw notFound('Conversation not found.')
  ok(res, row)
}))

api.patch('/ai/conversations/:id', requirePermission('ai:use'), asyncHandler(async (req, res) => {
  const title = z.object({ title: z.string().min(1).max(80) }).parse(req.body).title
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

api.get('/simulator/status', requirePermission('simulator:control'), asyncHandler(async (_req, res) => ok(res, await simulatorStatus())))
api.get('/simulator/config', requirePermission('simulator:control'), asyncHandler(async (_req, res) => ok(res, await simulatorStatus())))
api.post('/simulator/start', requirePermission('simulator:control'), idempotency, asyncHandler(async (req, res) => {
  const status = await startSimulator()
  await writeAudit({ user: requireUser(req), action: 'SIMULATOR_STARTED', resource: 'SIMULATOR', req })
  ok(res, status)
}))
api.post('/simulator/stop', requirePermission('simulator:control'), asyncHandler(async (req, res) => {
  const status = await stopSimulator()
  await writeAudit({ user: requireUser(req), action: 'SIMULATOR_STOPPED', resource: 'SIMULATOR', req })
  ok(res, status)
}))
api.post('/simulator/reset', requirePermission('simulator:control'), asyncHandler(async (req, res) => {
  const status = await resetSimulator()
  await writeAudit({ user: requireUser(req), action: 'SIMULATOR_RESET', resource: 'SIMULATOR', req })
  ok(res, status)
}))
api.patch('/simulator/config', requirePermission('simulator:control'), asyncHandler(async (req, res) => {
  const body = z.object({
    tpm: z.number().int().min(1).max(600).optional(),
    successRate: z.number().min(0).max(1).optional(),
    failureRate: z.number().min(0).max(1).optional(),
    pendingRate: z.number().min(0).max(1).optional(),
    highValueRate: z.number().min(0).max(1).optional(),
    anomalyRate: z.number().min(0).max(1).optional(),
  }).parse(req.body)
  const total = (body.successRate ?? 0.94) + (body.failureRate ?? 0.04) + (body.pendingRate ?? 0.02)
  if (body.successRate != null && body.failureRate != null && body.pendingRate != null && Math.abs(total - 1) > 0.02) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Success, failure, and pending rates must add up to about 100%.')
  }
  const status = await updateSimulator(body)
  await writeAudit({ user: requireUser(req), action: 'SIMULATOR_CONFIGURED', resource: 'SIMULATOR', req, newValue: body })
  ok(res, status)
}))
api.post('/simulator/scenario', requirePermission('simulator:control'), idempotency, asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.enum(['BANK_API_LATENCY', 'PAYMENT_FAILURE_SPIKE', 'SETTLEMENT_DELAY', 'NOTIFICATION_DEGRADATION', 'HIGH_VOLUME', 'MERCHANT_ACTIVITY']),
    intensity: z.number().min(0.5).max(2).optional(),
  }).parse(req.body)
  const status = await startScenario(body.name, body.intensity ?? 1)
  await writeAudit({ user: requireUser(req), action: 'SCENARIO_STARTED', resource: 'SIMULATOR', resourceId: body.name, req })
  ok(res, status)
}))
api.post('/simulator/scenario/resolve', requirePermission('simulator:control'), asyncHandler(async (req, res) => {
  const status = await resolveScenario()
  await writeAudit({ user: requireUser(req), action: 'SCENARIO_RESOLVED', resource: 'SIMULATOR', req })
  ok(res, status)
}))

api.post('/dev/reset-demo', asyncHandler(async (req, res) => {
  if (env.isProd) throw notFound('Feature unavailable in this environment.')
  const user = requireUser(req)
  if (user.role !== 'SUPER_ADMIN') throw forbidden()
  ok(res, { message: 'Use npm run db:seed to reseed. This endpoint confirms the admin is authorized to reset demo data.', authorized: true })
}))

function param(req: { params: Record<string, string | string[] | undefined> }) {
  const value = req.params.id ?? req.params.cadence
  return Array.isArray(value) ? value[0] : String(value)
}

function optionalString(value: unknown) {
  return typeof value === 'string' ? value : undefined
}
