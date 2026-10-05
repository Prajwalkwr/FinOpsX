import { Prisma, type DqStatus, type DqType } from '@prisma/client'
import type { Request } from 'express'
import { notFound } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { pageOf } from '../lib/http.js'
import { num, prisma } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'
import { writeAudit } from './audit.js'

const CUSTOMER_PATTERN = '^CUS-\\*{6}[0-9]{3}$'

/** Each check is a WHERE clause over Transaction (aliased t). The same clause drives counts and the affected-record drill-down. */
const CHECKS: Record<DqType, { title: string; description: string; where: () => Prisma.Sql; dimension: 'completeness' | 'accuracy' | 'duplicates' | 'timeliness' }> = {
  MISSING_MERCHANT_REFERENCE: {
    title: 'Missing merchant reference',
    description: 'Transactions without the merchant order reference needed for merchant reconciliation.',
    where: () => Prisma.sql`t."merchantReference" IS NULL`,
    dimension: 'completeness',
  },
  DUPLICATE_CORRELATION_ID: {
    title: 'Duplicate correlation ID',
    description: 'Transactions sharing a correlation ID with another transaction, which breaks request tracing.',
    where: () => Prisma.sql`t."correlationId" IN (SELECT "correlationId" FROM "Transaction" GROUP BY "correlationId" HAVING COUNT(*) > 1)`,
    dimension: 'duplicates',
  },
  INVALID_CUSTOMER_ID: {
    title: 'Invalid customer ID',
    description: 'Customer references that do not match the masked CUS-******NNN format.',
    where: () => Prisma.sql`t."customerId" !~ ${CUSTOMER_PATTERN}`,
    dimension: 'accuracy',
  },
  MISSING_RESPONSE_CODE: {
    title: 'Missing response code',
    description: 'Completed transactions without an institution response code.',
    where: () => Prisma.sql`t."responseCode" IS NULL AND t.status NOT IN ('PENDING', 'INITIATED', 'PROCESSING')`,
    dimension: 'completeness',
  },
  MISSING_FAILURE_REASON: {
    title: 'Failed payment without failure reason',
    description: 'Failed transactions that do not record why they failed.',
    where: () => Prisma.sql`t.status = 'FAILED' AND t."failureReason" IS NULL`,
    dimension: 'completeness',
  },
  DELAYED_SETTLEMENT: {
    title: 'Delayed settlement event',
    description: 'Successful payments whose settlement is delayed or still queued more than 2 hours after completion.',
    where: () => Prisma.sql`(t."settlementStatus" = 'DELAYED' OR (t.status = 'SUCCESS' AND t."settlementStatus" = 'QUEUED' AND t."createdAt" < ${new Date(Date.now() - 2 * 3600_000)}))`,
    dimension: 'timeliness',
  },
  MISSING_LEDGER_RECORD: {
    title: 'Missing institution ledger record',
    description: 'Successful or reversed payments older than 5 minutes with no matching record in the institution ledger.',
    where: () => Prisma.sql`t.status IN ('SUCCESS', 'SETTLED', 'REVERSED') AND t."createdAt" < ${new Date(Date.now() - 5 * 60_000)} AND NOT EXISTS (SELECT 1 FROM "InstitutionLedgerEntry" l WHERE l."transactionId" = t.id)`,
    dimension: 'accuracy',
  },
}

export const DQ_TYPES = Object.keys(CHECKS) as DqType[]

async function countFor(type: DqType) {
  const [row] = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`SELECT COUNT(*)::int AS count FROM "Transaction" t WHERE ${CHECKS[type].where()}`)
  return row?.count ?? 0
}

/** Runs every check, upserts one issue row per type, and returns the dashboard metrics. */
export async function runDataQualityScan() {
  const [total, ...counts] = await Promise.all([prisma.transaction.count(), ...DQ_TYPES.map(countFor)])
  const byType = Object.fromEntries(DQ_TYPES.map((type, index) => [type, counts[index]])) as Record<DqType, number>
  const existing = await prisma.dataQualityIssue.findMany()
  for (const [index, type] of DQ_TYPES.entries()) {
    const count = byType[type]
    const current = existing.find((row) => row.type === type)
    if (!current) {
      await prisma.dataQualityIssue.create({
        data: { publicId: `DQ-${String(index + 1).padStart(3, '0')}`, type, title: CHECKS[type].title, description: CHECKS[type].description, affectedCount: count, status: count ? 'OPEN' : 'RESOLVED', resolvedAt: count ? null : new Date() },
      })
      continue
    }
    let status: DqStatus = current.status
    if (count === 0) status = 'RESOLVED'
    else if (current.status === 'RESOLVED' && count > current.affectedCount) status = 'OPEN'
    await prisma.dataQualityIssue.update({
      where: { id: current.id },
      data: { affectedCount: count, lastCheckedAt: new Date(), status, resolvedAt: status === 'RESOLVED' ? current.resolvedAt ?? new Date() : null },
    })
  }
  emit('dataquality:scanned', { total })
  return { total, byType, processed: total, failed: Object.values(byType).reduce((sum, value) => sum + value, 0) }
}

export async function dataQualityOverview() {
  const [total, issues] = await Promise.all([prisma.transaction.count(), prisma.dataQualityIssue.findMany({ orderBy: { publicId: 'asc' } })])
  const count = (type: DqType) => issues.find((row) => row.type === type)?.affectedCount ?? 0
  const [incompleteRows] = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS count FROM "Transaction" t
    WHERE ${CHECKS.MISSING_MERCHANT_REFERENCE.where()} OR (${CHECKS.MISSING_RESPONSE_CODE.where()}) OR (${CHECKS.MISSING_FAILURE_REASON.where()})`)
  const ratio = (value: number) => (total ? (value / total) * 100 : 0)
  const missingFields = count('MISSING_MERCHANT_REFERENCE') + count('MISSING_RESPONSE_CODE') + count('MISSING_FAILURE_REASON')
  const inaccurate = count('INVALID_CUSTOMER_ID') + count('MISSING_LEDGER_RECORD')
  return {
    totalRecords: total,
    lastCheckedAt: issues.reduce<Date | null>((latest, row) => (!latest || row.lastCheckedAt > latest ? row.lastCheckedAt : latest), null)?.toISOString() ?? null,
    metrics: {
      completeness: total ? 100 - ratio(incompleteRows?.count ?? 0) : 100,
      accuracy: total ? 100 - ratio(inaccurate) : 100,
      duplicateRate: ratio(count('DUPLICATE_CORRELATION_ID')),
      invalidIds: count('INVALID_CUSTOMER_ID'),
      missingFields,
      delayedEvents: count('DELAYED_SETTLEMENT'),
    },
    issues: issues.map((row) => ({
      id: row.publicId,
      type: row.type,
      title: row.title,
      description: row.description,
      dimension: CHECKS[row.type].dimension,
      affectedCount: row.affectedCount,
      affectedPct: ratio(row.affectedCount),
      status: row.status,
      note: row.note,
      detectedAt: row.detectedAt.toISOString(),
      lastCheckedAt: row.lastCheckedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    })),
  }
}

export async function affectedRecords(id: string, query: { page: number; limit: number }) {
  const issue = await prisma.dataQualityIssue.findFirst({ where: { OR: [{ id }, { publicId: id }, ...(DQ_TYPES.includes(id as DqType) ? [{ type: id as DqType }] : [])] } })
  if (!issue) throw notFound('Data quality issue not found.')
  const where = CHECKS[issue.type].where()
  const offset = (query.page - 1) * query.limit
  const [countRow, rows] = await Promise.all([
    prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`SELECT COUNT(*)::int AS count FROM "Transaction" t WHERE ${where}`),
    prisma.$queryRaw<Array<{ transactionId: string; correlationId: string; customerId: string; merchantReference: string | null; status: string; responseCode: string | null; failureReason: string | null; settlementStatus: string; amount: Prisma.Decimal; institution: string; merchant: string; createdAt: Date }>>(Prisma.sql`
      SELECT t."transactionId", t."correlationId", t."customerId", t."merchantReference", t.status::text AS status, t."responseCode",
        t."failureReason"::text AS "failureReason", t."settlementStatus"::text AS "settlementStatus", t.amount, i.name AS institution, m.name AS merchant, t."createdAt"
      FROM "Transaction" t JOIN "Institution" i ON i.id = t."institutionId" JOIN "Merchant" m ON m.id = t."merchantId"
      WHERE ${where} ORDER BY t."createdAt" DESC LIMIT ${query.limit} OFFSET ${offset}`),
  ])
  return {
    issue: { id: issue.publicId, type: issue.type, title: issue.title, status: issue.status },
    records: pageOf(rows.map((row) => ({ ...row, amount: num(row.amount), createdAt: row.createdAt.toISOString() })), countRow[0]?.count ?? 0, query.page, query.limit),
  }
}

export async function updateIssue(id: string, input: { status: DqStatus; note?: string }, user: AuthUser, req: Request) {
  const issue = await prisma.dataQualityIssue.findFirst({ where: { OR: [{ id }, { publicId: id }] } })
  if (!issue) throw notFound('Data quality issue not found.')
  await prisma.dataQualityIssue.update({ where: { id: issue.id }, data: { status: input.status, note: input.note ?? issue.note, resolvedAt: input.status === 'RESOLVED' ? new Date() : null } })
  await writeAudit({ user, action: 'UPDATED_DATA_QUALITY_ISSUE', resource: 'DATA_QUALITY', resourceId: issue.publicId, req, previousValue: { status: issue.status }, newValue: { status: input.status, note: input.note ?? null } })
  return dataQualityOverview()
}
