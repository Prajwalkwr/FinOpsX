import { Prisma, type TxStatus, type PaymentMethod, type FailureReason } from '@prisma/client'
import { pageOf } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { getThresholds } from './thresholds.js'
import { serializeTransaction } from './metricsService.js'
import { writeAudit } from './audit.js'
import type { AuthUser } from '../lib/http.js'
import type { Request } from 'express'
import { notFound } from '../lib/errors.js'

const SORTS = new Set(['createdAt', 'amount', 'responseTimeMs', 'riskScore', 'status'])

export async function listTransactions(query: {
  page: number
  limit: number
  q?: string
  status?: string
  institutionId?: string
  merchantId?: string
  paymentMethod?: string
  minAmount?: number
  maxAmount?: number
  from?: string
  to?: string
  minRisk?: number
  failureReason?: string
  sort?: string
  dir?: string
  suspicious?: boolean
  highValue?: boolean
  preset?: string
}) {
  const thresholds = await getThresholds()
  const where: Prisma.TransactionWhereInput = {}
  if (query.status && query.status !== 'ALL') where.status = query.status as TxStatus
  if (query.preset === 'SUCCESSFUL') where.status = 'SUCCESS'
  if (query.preset === 'FAILED') where.status = 'FAILED'
  if (query.preset === 'PENDING') where.status = 'PENDING'
  if (query.preset === 'REFUNDED') where.status = 'REFUNDED'
  if (query.preset === 'CANCELLED') where.status = 'CANCELLED'
  if (query.preset === 'SUSPICIOUS' || query.suspicious) where.suspicious = true
  if (query.preset === 'HIGH_VALUE' || query.highValue) where.amount = { gte: thresholds.highValueAmount }
  if (query.institutionId) where.institutionId = query.institutionId
  if (query.merchantId) where.merchantId = query.merchantId
  if (query.paymentMethod) where.paymentMethod = query.paymentMethod as PaymentMethod
  if (query.failureReason) where.failureReason = query.failureReason as FailureReason
  if (query.minRisk != null) where.riskScore = { gte: query.minRisk }
  if (query.minAmount != null || query.maxAmount != null || (where.amount && query.preset === 'HIGH_VALUE')) {
    where.amount = {
      ...(typeof where.amount === 'object' ? where.amount : {}),
      ...(query.minAmount != null ? { gte: query.minAmount } : {}),
      ...(query.maxAmount != null ? { lte: query.maxAmount } : {}),
    }
  }
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    }
  }
  if (query.q) {
    where.OR = [
      { transactionId: { contains: query.q, mode: 'insensitive' } },
      { customerId: { contains: query.q, mode: 'insensitive' } },
      { correlationId: { contains: query.q, mode: 'insensitive' } },
      { merchant: { name: { contains: query.q, mode: 'insensitive' } } },
      { institution: { name: { contains: query.q, mode: 'insensitive' } } },
    ]
  }
  const sort = SORTS.has(query.sort || '') ? query.sort! : 'createdAt'
  const dir = query.dir === 'asc' ? 'asc' : 'desc'
  const orderBy: Prisma.TransactionOrderByWithRelationInput =
    sort === 'amount'
      ? { amount: dir }
      : sort === 'responseTimeMs'
        ? { responseTimeMs: dir }
        : sort === 'riskScore'
          ? { riskScore: dir }
          : sort === 'status'
            ? { status: dir }
            : { createdAt: dir }
  const skip = (query.page - 1) * query.limit
  const [total, rows] = await prisma.$transaction([
    prisma.transaction.count({ where }),
    prisma.transaction.findMany({
      where,
      orderBy,
      skip,
      take: query.limit,
      include: { institution: true, merchant: true },
    }),
  ])
  return pageOf(rows.map(serializeTransaction), total, query.page, query.limit)
}

export async function getTransaction(id: string) {
  const row = await prisma.transaction.findFirst({
    where: { OR: [{ id }, { transactionId: id }] },
    include: {
      institution: true,
      merchant: true,
      events: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!row) throw notFound('Transaction not found.')
  const stored = row.events.map((event) => ({
    id: event.id,
    service: event.service,
    event: event.event,
    status: event.status,
    timestamp: event.createdAt.toISOString(),
  }))
  const fallback = [
    ['Payment Switch', 'Request received', 'OK'],
    ['Banking API', 'Bank authentication', 'OK'],
    ['Transaction Processor', 'Payment processing', 'OK'],
    ['Banking API', 'Bank response', row.status],
    ['Transaction Processor', row.status === 'SUCCESS' ? 'Transaction completed' : 'Transaction updated', row.status],
    ['Settlement Service', row.settlementStatus === 'QUEUED' ? 'Settlement queued' : 'Settlement status recorded', row.settlementStatus],
  ].map((item, index) => ({
    id: `fallback-${index}`,
    service: item[0],
    event: item[1],
    status: item[2],
    timestamp: new Date(row.createdAt.getTime() + index * 50).toISOString(),
  }))
  return {
    ...serializeTransaction(row),
    timeline: stored.length ? stored : fallback,
  }
}

export async function investigateTransaction(id: string, user: AuthUser, req: Request) {
  const row = await getTransaction(id)
  const since = new Date(Date.now() - 3600_000)
  const existing = await prisma.auditLog.findFirst({
    where: {
      userId: user.id,
      action: 'INVESTIGATED_TRANSACTION',
      resourceId: row.transactionId,
      createdAt: { gte: since },
    },
  })
  if (!existing) {
    await writeAudit({
      user,
      action: 'INVESTIGATED_TRANSACTION',
      resource: 'TRANSACTION',
      resourceId: row.transactionId,
      req,
    })
  }
  return row
}
