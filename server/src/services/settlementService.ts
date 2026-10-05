import { Prisma } from '@prisma/client'
import { createWithPublicId } from '../lib/ids.js'
import { prisma, num } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'

async function scenarioDelaysSettlement() {
  const config = await prisma.simulatorConfig.findUnique({ where: { id: 'default' } })
  return config?.scenario === 'SETTLEMENT_DELAY'
}

/**
 * Settles queued successful payments in one batch per institution.
 * During the Settlement Delay scenario automatic cycles mark the batches DELAYED instead.
 */
export async function runSettlementCycle(input: { source: 'auto' | 'eod' | 'manual'; minAgeMs?: number; jobId?: string }) {
  const delayed = input.source === 'auto' && (await scenarioDelaysSettlement())
  const cutoff = new Date(Date.now() - (input.minAgeMs ?? 0))
  const queued = await prisma.transaction.findMany({
    where: { status: 'SUCCESS', settlementStatus: { in: delayed ? ['QUEUED'] : ['QUEUED', 'DELAYED'] }, settlementId: null, createdAt: { lte: cutoff } },
    select: { id: true, institutionId: true, amount: true },
    take: 20000,
  })
  const reopened = delayed ? [] : await prisma.settlement.findMany({ where: { status: 'DELAYED' } })
  const groups = new Map<string, typeof queued>()
  for (const row of queued) groups.set(row.institutionId, [...(groups.get(row.institutionId) ?? []), row])
  const endpoint = await prisma.apiEndpoint.findUnique({ where: { method_endpoint: { method: 'POST', endpoint: '/settlement' } } })
  const now = new Date()
  let settledTx = 0
  let delayedTx = 0
  let amount = 0
  const batches: string[] = []
  for (const [institutionId, members] of groups) {
    const total = members.reduce((sum, row) => sum + num(row.amount), 0)
    const batch = await createWithPublicId(
      async () => (await prisma.settlement.count()) + 1,
      (n) => `STL-${String(n).padStart(5, '0')}`,
      (publicId) => prisma.settlement.create({
        data: {
          publicId,
          institutionId,
          status: delayed ? 'DELAYED' : 'SETTLED',
          transactionCount: members.length,
          amount: total,
          expectedAt: now,
          settledAt: delayed ? null : now,
          jobId: input.jobId,
        },
      }),
    )
    const publicId = batch.publicId
    const ids = members.map((row) => row.id)
    await prisma.transaction.updateMany({
      where: { id: { in: ids } },
      data: delayed
        ? { settlementStatus: 'DELAYED', settlementId: batch.id }
        : { status: 'SETTLED', settlementStatus: 'SETTLED', settlementId: batch.id, settledAt: now, lifecycleStage: 'COMPLETED' },
    })
    await prisma.transactionEvent.createMany({
      data: ids.flatMap((transactionId) => delayed
        ? [{ transactionId, service: 'Settlement', event: 'SETTLEMENT', status: 'DELAYED', createdAt: now }]
        : [
            { transactionId, service: 'Settlement', event: 'SETTLEMENT', status: 'SETTLED', createdAt: now },
            { transactionId, service: 'Settlement', event: 'COMPLETED', status: 'OK', createdAt: new Date(now.getTime() + 500) },
          ]),
    })
    if (endpoint) {
      await prisma.apiCall.create({ data: { endpointId: endpoint.id, statusCode: delayed ? 504 : 200, latencyMs: delayed ? 12000 + Math.round(Math.random() * 2000) : 600 + Math.round(Math.random() * 300), institutionId, transactionRef: publicId } })
    }
    batches.push(publicId)
    if (delayed) delayedTx += members.length
    else {
      settledTx += members.length
      amount += total
    }
  }
  for (const batch of reopened) {
    await prisma.settlement.update({ where: { id: batch.id }, data: { status: 'SETTLED', settledAt: now } })
    const members = await prisma.transaction.findMany({ where: { settlementId: batch.id, status: 'SUCCESS' }, select: { id: true } })
    await prisma.transaction.updateMany({ where: { settlementId: batch.id, status: 'SUCCESS' }, data: { status: 'SETTLED', settlementStatus: 'SETTLED', settledAt: now, lifecycleStage: 'COMPLETED' } })
    if (members.length) {
      await prisma.transactionEvent.createMany({ data: members.flatMap((row) => [
        { transactionId: row.id, service: 'Settlement', event: 'SETTLEMENT', status: 'SETTLED', createdAt: now },
        { transactionId: row.id, service: 'Settlement', event: 'COMPLETED', status: 'OK', createdAt: new Date(now.getTime() + 500) },
      ]) })
    }
    settledTx += batch.transactionCount
    amount += num(batch.amount)
    batches.push(batch.publicId)
  }
  if (batches.length) emit('settlement:updated', { batches: batches.length, delayed })
  return { batches, settledTransactions: settledTx, delayedTransactions: delayedTx, settledAmount: amount, delayed }
}

/** Confirms that each settlement batch total equals the sum of the transactions linked to it. */
export async function validateSettlements(days = 7) {
  const since = new Date(Date.now() - days * 86400_000)
  const rows = await prisma.$queryRaw<Array<{ id: string; publicId: string; amount: number; transactionCount: number; actualAmount: number; actualCount: number; status: string }>>(Prisma.sql`
    SELECT s.id, s."publicId", s.amount::float AS amount, s."transactionCount", s.status::text AS status,
      COALESCE(SUM(t.amount), 0)::float AS "actualAmount", COUNT(t.id)::int AS "actualCount"
    FROM "Settlement" s LEFT JOIN "Transaction" t ON t."settlementId" = s.id
    WHERE s."createdAt" >= ${since}
    GROUP BY s.id ORDER BY s."createdAt" DESC`)
  const mismatches = rows.filter((row) => Math.abs(row.amount - row.actualAmount) > 0.009 || row.transactionCount !== row.actualCount)
  const delayed = rows.filter((row) => row.status === 'DELAYED')
  return {
    processed: rows.length,
    successful: rows.length - mismatches.length - delayed.length,
    failed: mismatches.length + delayed.length,
    mismatches: mismatches.slice(0, 50).map((row) => ({ batch: row.publicId, recordedAmount: row.amount, transactionAmount: row.actualAmount, recordedCount: row.transactionCount, transactionCount: row.actualCount })),
    delayed: delayed.slice(0, 50).map((row) => row.publicId),
  }
}

export async function listSettlements(query: { page: number; limit: number; status?: string }) {
  const where: Prisma.SettlementWhereInput = query.status ? { status: query.status as Prisma.SettlementWhereInput['status'] } : {}
  const [total, rows] = await prisma.$transaction([
    prisma.settlement.count({ where }),
    prisma.settlement.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit, include: { institution: true } }),
  ])
  return {
    items: rows.map((row) => ({ id: row.publicId, institution: row.institution.name, status: row.status, transactionCount: row.transactionCount, amount: num(row.amount), createdAt: row.createdAt.toISOString(), settledAt: row.settledAt?.toISOString() ?? null })),
    page: query.page,
    limit: query.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  }
}
