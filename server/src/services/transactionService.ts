import { Prisma, type FailureReason, type PaymentMethod, type SettlementStatus, type TxStatus } from '@prisma/client'
import type { Request } from 'express'
import { notFound } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { pageOf } from '../lib/http.js'
import { num, prisma } from '../lib/prisma.js'
import { resolveRange } from '../utils/range.js'
import { writeAudit } from './audit.js'
import { serializeTransaction } from './metricsService.js'
import { getThresholds } from './thresholds.js'

const SORTS = new Set(['createdAt', 'amount', 'responseTimeMs', 'riskScore', 'status'])

export const FAILURE_TEXT: Record<string, string> = {
  TIMEOUT: 'The institution did not respond within the 8 second timeout.',
  BANK_API_ERROR: 'The institution API returned a server error.',
  INSUFFICIENT_FUNDS: 'The payer account had insufficient funds.',
  NETWORK_ERROR: 'A network error interrupted the request.',
  INVALID_REQUEST: 'The request failed validation at the institution.',
  SERVICE_UNAVAILABLE: 'The institution service was unavailable.',
  DUPLICATE_TRANSACTION: 'The institution rejected the payment as a duplicate.',
  AUTHENTICATION_FAILURE: 'Request authentication failed.',
  SETTLEMENT_DELAY: 'Settlement did not complete within the expected window.',
}

export type ListQuery = {
  page: number
  limit: number
  q?: string
  status?: string
  institutionId?: string
  institution?: string
  merchantId?: string
  paymentMethod?: string
  settlementStatus?: string
  minAmount?: number
  maxAmount?: number
  range?: string
  from?: string
  to?: string
  minRisk?: number
  failureReason?: string
  sort?: string
  dir?: string
  suspicious?: boolean
  highValue?: boolean
  preset?: string
}

export async function buildTransactionWhere(query: ListQuery): Promise<Prisma.TransactionWhereInput> {
  const thresholds = await getThresholds()
  const where: Prisma.TransactionWhereInput = {}
  const status = query.preset && query.preset !== 'ALL' ? query.preset : query.status
  if (status && status !== 'ALL') {
    if (status === 'SUCCESSFUL') where.status = { in: ['SUCCESS', 'SETTLED'] }
    else if (status === 'SUSPICIOUS') where.suspicious = true
    else if (status === 'HIGH_VALUE') where.amount = { gte: thresholds.highValueAmount }
    else where.status = status as TxStatus
  }
  if (query.suspicious) where.suspicious = true
  if (query.highValue) where.amount = { gte: thresholds.highValueAmount }
  if (query.institutionId) where.institutionId = query.institutionId
  if (query.institution) where.institution = { code: query.institution.toUpperCase() }
  if (query.merchantId) where.merchantId = query.merchantId
  if (query.paymentMethod) where.paymentMethod = query.paymentMethod as PaymentMethod
  if (query.failureReason) where.failureReason = query.failureReason as FailureReason
  if (query.settlementStatus) where.settlementStatus = query.settlementStatus as SettlementStatus
  if (query.minRisk != null) where.riskScore = { gte: query.minRisk }
  if (query.minAmount != null || query.maxAmount != null) {
    where.amount = {
      ...(typeof where.amount === 'object' ? where.amount : {}),
      ...(query.minAmount != null ? { gte: query.minAmount } : {}),
      ...(query.maxAmount != null ? { lte: query.maxAmount } : {}),
    }
  }
  if (query.from || query.to) {
    where.createdAt = { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) }
  } else if (query.range && query.range !== 'all') {
    const range = resolveRange({ range: query.range })
    where.createdAt = { gte: range.from, lte: range.to }
  }
  if (query.q) {
    where.OR = [
      { transactionId: { contains: query.q, mode: 'insensitive' } },
      { customerId: { contains: query.q, mode: 'insensitive' } },
      { correlationId: { contains: query.q, mode: 'insensitive' } },
      { merchantReference: { contains: query.q, mode: 'insensitive' } },
      { merchant: { name: { contains: query.q, mode: 'insensitive' } } },
      { institution: { name: { contains: query.q, mode: 'insensitive' } } },
    ]
  }
  return where
}

export async function listTransactions(query: ListQuery) {
  const where = await buildTransactionWhere(query)
  const sort = SORTS.has(query.sort || '') ? query.sort! : 'createdAt'
  const dir = query.dir === 'asc' ? 'asc' : 'desc'
  const orderBy = { [sort]: dir } as Prisma.TransactionOrderByWithRelationInput
  const skip = (query.page - 1) * query.limit
  const [total, rows] = await prisma.$transaction([
    prisma.transaction.count({ where }),
    prisma.transaction.findMany({ where, orderBy: [orderBy, { id: 'asc' }], skip, take: query.limit, include: { institution: true, merchant: true, destinationInstitution: true } }),
  ])
  return pageOf(rows.map(serializeTransaction), total, query.page, query.limit)
}

type StageStatus = 'done' | 'failed' | 'pending' | 'skipped' | 'warning'

/** Lifecycle derived only from stored events and stage timestamps; nothing is synthesised for display. */
function lifecycle(row: Prisma.TransactionGetPayload<{ include: { events: true } }>) {
  const find = (...names: string[]) => [...row.events].reverse().find((event) => names.includes(event.event))
  const outcome = find('SUCCESS', 'FAILED', 'PENDING')
  const settlement = find('SETTLEMENT')
  const completed = find('COMPLETED')
  const reversed = find('REVERSED')
  const authFailed = row.failureReason === 'AUTHENTICATION_FAILURE'
  const failed = row.status === 'FAILED'
  const stages: Array<{ stage: string; label: string; status: StageStatus; at: string | null; detail: string | null }> = [
    { stage: 'INITIATED', label: 'Initiated', status: 'done', at: (find('INITIATED')?.createdAt ?? row.initiatedAt ?? row.createdAt).toISOString(), detail: `${row.apiEndpoint} received` },
    { stage: 'AUTHENTICATING', label: 'Authenticated', status: authFailed ? 'failed' : 'done', at: (find('AUTHENTICATING')?.createdAt ?? row.authenticatedAt)?.toISOString() ?? null, detail: authFailed ? 'Authentication failed' : 'Token validated' },
    { stage: 'PROCESSING', label: 'Processing', status: authFailed ? 'skipped' : 'done', at: authFailed ? null : find('PROCESSING')?.createdAt.toISOString() ?? null, detail: authFailed ? null : `Routed to ${row.paymentMethod === 'WALLET' ? 'Wallet Service' : 'Bank API'}` },
    {
      stage: 'OUTCOME',
      label: failed ? 'Failed' : row.status === 'PENDING' ? 'Awaiting institution' : 'Authorized',
      status: failed ? 'failed' : row.status === 'PENDING' ? 'pending' : 'done',
      at: (outcome?.createdAt ?? row.processedAt)?.toISOString() ?? null,
      detail: failed ? FAILURE_TEXT[row.failureReason ?? ''] ?? 'Failed without a recorded reason.' : `Response ${row.responseCode ?? 'n/a'} in ${row.responseTimeMs}ms`,
    },
    {
      stage: 'SETTLEMENT',
      label: 'Settlement',
      status: failed || row.status === 'PENDING' || row.status === 'REVERSED' ? 'skipped' : row.settlementStatus === 'SETTLED' ? 'done' : row.settlementStatus === 'DELAYED' ? 'warning' : 'pending',
      at: (row.settledAt ?? settlement?.createdAt)?.toISOString() ?? null,
      detail: failed || row.status === 'PENDING' ? null : `Settlement ${row.settlementStatus.toLowerCase()}`,
    },
    {
      stage: 'COMPLETED',
      label: reversed ? 'Reversed' : 'Completed',
      status: row.status === 'PENDING' ? 'pending' : failed ? 'failed' : row.status === 'REVERSED' ? 'warning' : row.status === 'SETTLED' || row.status === 'SUCCESS' ? (row.settlementStatus === 'SETTLED' ? 'done' : 'pending') : 'done',
      at: (reversed?.createdAt ?? completed?.createdAt ?? row.completedAt)?.toISOString() ?? null,
      detail: row.status,
    },
  ]
  let previous: number | null = null
  return stages.map((stage) => {
    const at = stage.at ? new Date(stage.at).getTime() : null
    const sincePreviousMs = at != null && previous != null ? at - previous : null
    if (at != null) previous = at
    return { ...stage, sincePreviousMs }
  })
}

export async function getTransaction(id: string) {
  const row = await prisma.transaction.findFirst({
    where: { OR: [{ id }, { transactionId: id }] },
    include: { institution: true, merchant: true, destinationInstitution: true, events: { orderBy: { createdAt: 'asc' } }, ledgerEntry: true, settlement: true },
  })
  if (!row) throw notFound('Transaction not found.')
  const [apiCalls, duplicates] = await Promise.all([
    prisma.apiCall.findMany({ where: { transactionRef: row.transactionId }, orderBy: { createdAt: 'asc' }, include: { endpoint: true } }),
    prisma.transaction.count({ where: { correlationId: row.correlationId, id: { not: row.id } } }),
  ])
  const ledgerMatch = !['SUCCESS', 'SETTLED', 'REVERSED'].includes(row.status)
    ? 'NOT_APPLICABLE'
    : !row.ledgerEntry
      ? 'MISSING_AT_INSTITUTION'
      : num(row.ledgerEntry.amount) !== num(row.amount)
        ? 'AMOUNT_MISMATCH'
        : 'MATCHED'
  return {
    ...serializeTransaction(row),
    failureDescription: row.failureReason ? FAILURE_TEXT[row.failureReason] ?? null : null,
    stageTimestamps: {
      initiatedAt: row.initiatedAt?.toISOString() ?? null,
      authenticatedAt: row.authenticatedAt?.toISOString() ?? null,
      processedAt: row.processedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      settledAt: row.settledAt?.toISOString() ?? null,
    },
    lifecycle: lifecycle(row),
    timeline: row.events.map((event) => ({ id: event.id, service: event.service, event: event.event, status: event.status, timestamp: event.createdAt.toISOString() })),
    settlement: row.settlement ? { id: row.settlement.publicId, status: row.settlement.status, amount: num(row.settlement.amount), settledAt: row.settlement.settledAt?.toISOString() ?? null, transactionCount: row.settlement.transactionCount } : null,
    institutionRecord: row.ledgerEntry ? { reference: row.ledgerEntry.transactionRef, amount: num(row.ledgerEntry.amount), status: row.ledgerEntry.status, recordedAt: row.ledgerEntry.recordedAt.toISOString() } : null,
    ledgerMatch,
    duplicateCorrelationCount: duplicates,
    apiCalls: apiCalls.map((call) => ({ endpoint: `${call.endpoint.method} ${call.endpoint.endpoint}`, statusCode: call.statusCode, latencyMs: call.latencyMs, at: call.createdAt.toISOString() })),
  }
}

export async function investigateTransaction(id: string, user: AuthUser, req: Request) {
  const row = await getTransaction(id)
  const since = new Date(Date.now() - 3600_000)
  const existing = await prisma.auditLog.findFirst({ where: { userId: user.id, action: 'INVESTIGATED_TRANSACTION', resourceId: row.transactionId, createdAt: { gte: since } } })
  if (!existing) await writeAudit({ user, action: 'INVESTIGATED_TRANSACTION', resource: 'TRANSACTION', resourceId: row.transactionId, req })
  return row
}
