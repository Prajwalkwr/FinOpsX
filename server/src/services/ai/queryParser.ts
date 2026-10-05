import { z } from 'zod'

/**
 * Structured query language shared by the AI assistant and Ask Your Data.
 * Natural language is parsed into this whitelist; only the executor turns it into Prisma calls. No SQL text is ever produced.
 */
export const ENTITIES = ['transactions', 'incidents', 'anomalies', 'settlements', 'api_endpoints', 'jobs', 'data_quality'] as const
export const METRICS = ['count', 'sum_amount', 'avg_amount', 'failure_rate', 'success_rate', 'avg_latency', 'p95_latency'] as const
export const GROUP_BYS = ['institution', 'merchant', 'payment_method', 'status', 'failure_reason', 'hour', 'day', 'severity', 'type'] as const
export const RANGES = ['1h', '6h', '24h', 'today', 'yesterday', '7d', '30d'] as const
export const INSTITUTION_CODES = ['DBA', 'DBB', 'DBC', 'DWL', 'DPN', 'DMN'] as const
export const TX_STATUS_FILTERS = ['SUCCESS', 'SETTLED', 'FAILED', 'PENDING', 'REVERSED', 'INITIATED', 'PROCESSING'] as const
export const METHOD_FILTERS = ['QR', 'WALLET', 'BANK_TRANSFER', 'CARD', 'ACCOUNT_PAYMENT'] as const
export const REASON_FILTERS = ['TIMEOUT', 'BANK_API_ERROR', 'INSUFFICIENT_FUNDS', 'NETWORK_ERROR', 'INVALID_REQUEST', 'SERVICE_UNAVAILABLE', 'DUPLICATE_TRANSACTION', 'AUTHENTICATION_FAILURE', 'SETTLEMENT_DELAY'] as const
export const SEVERITY_FILTERS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

export const structuredQuerySchema = z.object({
  entity: z.enum(ENTITIES),
  mode: z.enum(['list', 'aggregate']),
  metric: z.enum(METRICS).optional(),
  groupBy: z.enum(GROUP_BYS).optional(),
  range: z.enum(RANGES),
  filters: z.object({
    status: z.array(z.enum(TX_STATUS_FILTERS)).max(7).optional(),
    institution: z.enum(INSTITUTION_CODES).optional(),
    paymentMethod: z.enum(METHOD_FILTERS).optional(),
    failureReason: z.enum(REASON_FILTERS).optional(),
    minAmount: z.number().nonnegative().max(1e9).optional(),
    maxAmount: z.number().positive().max(1e9).optional(),
    severity: z.enum(SEVERITY_FILTERS).optional(),
    merchant: z.string().trim().min(2).max(60).regex(/^[\w\s.&'-]+$/).optional(),
    activeOnly: z.boolean().optional(),
  }).strict().default({}),
  sort: z.object({ field: z.enum(['createdAt', 'amount', 'metric']), dir: z.enum(['asc', 'desc']) }).optional(),
  limit: z.number().int().min(1).max(200).default(25),
}).strict()

export type StructuredQuery = z.infer<typeof structuredQuerySchema>

export type ParseResult =
  | { ok: true; query: StructuredQuery; interpretation: string[] }
  | { ok: false; reason: 'refused' | 'unsupported'; message: string }

const SQL_PATTERN = /\b(drop|truncate|alter|insert|update|grant|revoke)\b\s+\w|\bdelete\s+from\b|\bselect\b.+\bfrom\b|;\s*--|union\s+select|pg_sleep|information_schema/i

const INSTITUTION_WORDS: Array<[RegExp, (typeof INSTITUTION_CODES)[number], string]> = [
  [/\b(demo\s+)?bank\s*a\b/, 'DBA', 'Demo Bank A'],
  [/\b(demo\s+)?bank\s*b\b/, 'DBB', 'Demo Bank B'],
  [/\b(demo\s+)?bank\s*c\b/, 'DBC', 'Demo Bank C'],
  [/\bdemo\s+wallet\b/, 'DWL', 'Demo Wallet'],
  [/\b(demo\s+)?payment\s+network\b/, 'DPN', 'Demo Payment Network'],
  [/\b(demo\s+)?merchant\s+network\b/, 'DMN', 'Demo Merchant Network'],
]

const REASON_WORDS: Array<[RegExp, (typeof REASON_FILTERS)[number]]> = [
  [/time\s*-?\s*outs?|timed out/, 'TIMEOUT'],
  [/bank api error/, 'BANK_API_ERROR'],
  [/insufficient (funds|balance)/, 'INSUFFICIENT_FUNDS'],
  [/network error/, 'NETWORK_ERROR'],
  [/invalid request/, 'INVALID_REQUEST'],
  [/service unavailable/, 'SERVICE_UNAVAILABLE'],
  [/duplicate transaction/, 'DUPLICATE_TRANSACTION'],
  [/auth(entication)? fail/, 'AUTHENTICATION_FAILURE'],
]

function parseAmount(raw: string, unit?: string) {
  const value = Number(raw.replace(/,/g, ''))
  if (!Number.isFinite(value)) return undefined
  if (!unit) return value
  if (/^k$/i.test(unit)) return value * 1000
  if (/^lakhs?$/i.test(unit)) return value * 100000
  if (/^(m|million)$/i.test(unit)) return value * 1_000_000
  if (/^crores?$/i.test(unit)) return value * 10_000_000
  return value
}

export function parseRange(q: string): (typeof RANGES)[number] {
  if (/\byesterday\b/.test(q)) return 'yesterday'
  if (/\btoday\b|\bso far\b/.test(q)) return 'today'
  if (/\b(last|past)\s+(hour|60\s*min)/.test(q)) return '1h'
  if (/\b(last|past)\s+6\s*hours?\b/.test(q)) return '6h'
  if (/\b(week|7\s*days)\b/.test(q)) return '7d'
  if (/\b(month|30\s*days)\b/.test(q)) return '30d'
  return '24h'
}

/** Deterministic natural-language parser. Unrecognised questions are reported as unsupported instead of guessed. */
export function parseQuestion(question: string): ParseResult {
  const q = question.toLowerCase().replace(/\s+/g, ' ').trim()
  if (SQL_PATTERN.test(q) || /\b(raw|arbitrary) sql\b/.test(q)) {
    return { ok: false, reason: 'refused', message: 'I can only run approved, read-only structured queries. Arbitrary SQL is not allowed.' }
  }
  if (/\b(delete|transfer money|move money|pay ?out|change (the )?balance|reverse (this|the|a) (payment|transaction)|issue (a )?refund)\b/.test(q)) {
    return { ok: false, reason: 'refused', message: 'I can only read operational data. I cannot change records or move money.' }
  }
  const notes: string[] = []
  const filters: StructuredQuery['filters'] = {}

  let entity: StructuredQuery['entity'] = 'transactions'
  if (/\bincidents?\b/.test(q)) entity = 'incidents'
  else if (/\banomal(y|ies)\b/.test(q)) entity = 'anomalies'
  else if (/\bsettlement batch(es)?\b|\bsettlements\b/.test(q)) entity = 'settlements'
  else if (/\b(api|apis|endpoints?)\b/.test(q)) entity = 'api_endpoints'
  else if (/\b(jobs?|eod|bod)\b/.test(q)) entity = 'jobs'
  else if (/\bdata quality\b/.test(q)) entity = 'data_quality'
  const recognisedEntity = entity !== 'transactions' || /\b(transactions?|payments?|txns?|volume|value|failures?|failed|declin|success|pending|reversed|settled|merchants?|banks?|institutions?|wallet|qr|card|amount)\b/.test(q)
  if (!recognisedEntity) {
    return { ok: false, reason: 'unsupported', message: "I don't have enough data to answer that." }
  }

  const range = parseRange(q)
  notes.push(`Time range: ${range}`)

  for (const [pattern, code, name] of INSTITUTION_WORDS) {
    if (pattern.test(q)) {
      filters.institution = code
      notes.push(`Institution: ${name}`)
      break
    }
  }

  if (entity === 'transactions') {
    const statuses: StructuredQuery['filters']['status'] = []
    if (/\b(failed|failures?|failing|declined)\b/.test(q) && !/\bfailure rate\b/.test(q)) statuses.push('FAILED')
    if (/\b(successful|succeeded|success(ful)? payments)\b/.test(q) && !/\bsuccess rate\b/.test(q)) statuses.push('SUCCESS', 'SETTLED')
    if (/\bpending\b/.test(q)) statuses.push('PENDING')
    if (/\breversed|reversals?\b/.test(q)) statuses.push('REVERSED')
    if (/\bsettled\b/.test(q) && !statuses.includes('SETTLED')) statuses.push('SETTLED')
    if (statuses.length) {
      filters.status = [...new Set(statuses)]
      notes.push(`Status: ${filters.status.join(', ')}`)
    }
    if (/\bqr\b/.test(q)) filters.paymentMethod = 'QR'
    else if (/\bcard\b/.test(q)) filters.paymentMethod = 'CARD'
    else if (/\bbank transfer\b/.test(q)) filters.paymentMethod = 'BANK_TRANSFER'
    else if (/\baccount payment\b/.test(q)) filters.paymentMethod = 'ACCOUNT_PAYMENT'
    else if (/\bwallet (payments?|transactions?)\b/.test(q)) filters.paymentMethod = 'WALLET'
    if (filters.paymentMethod) notes.push(`Payment method: ${filters.paymentMethod}`)
    for (const [pattern, reason] of REASON_WORDS) {
      if (pattern.test(q)) {
        filters.failureReason = reason
        if (!filters.status) filters.status = ['FAILED']
        notes.push(`Failure reason: ${reason}`)
        break
      }
    }
    const above = q.match(/\b(?:above|over|more than|greater than|at least|>=?)\s*(?:rs\.?|npr)?\s*([\d,.]+)\s*(k|lakhs?|m|million|crores?)?\b/)
    const below = q.match(/\b(?:below|under|less than|<=?)\s*(?:rs\.?|npr)?\s*([\d,.]+)\s*(k|lakhs?|m|million|crores?)?\b/)
    if (above) filters.minAmount = parseAmount(above[1], above[2])
    if (below) filters.maxAmount = parseAmount(below[1], below[2])
    if (/\bhigh[- ]value\b/.test(q) && filters.minAmount == null) filters.minAmount = 100000
    if (filters.minAmount != null) notes.push(`Amount ≥ Rs. ${filters.minAmount.toLocaleString('en-US')}`)
    if (filters.maxAmount != null) notes.push(`Amount ≤ Rs. ${filters.maxAmount.toLocaleString('en-US')}`)
    const merchant = q.match(/\bat (demo [a-z]+(?: [a-z]+)?)\b/)
    if (merchant && !/\bbank|wallet|network\b/.test(merchant[1])) {
      filters.merchant = merchant[1]
      notes.push(`Merchant contains: ${merchant[1]}`)
    }
  }
  if (entity === 'incidents' || entity === 'anomalies') {
    const severity = q.match(/\b(low|medium|high|critical)\b/)
    if (severity) {
      filters.severity = severity[1].toUpperCase() as StructuredQuery['filters']['severity']
      notes.push(`Severity: ${filters.severity}`)
    }
    if (/\b(active|open|current|ongoing)\b/.test(q)) {
      filters.activeOnly = true
      notes.push('Only active/open records')
    }
  }

  let groupBy: StructuredQuery['groupBy']
  if (/\b(by|per|each|across) (bank|institution)s?\b|\bwhich (bank|institution)\b|\bcompare (banks|institutions)\b/.test(q)) groupBy = 'institution'
  else if (/\b(by|per|each) merchants?\b|\bwhich merchant\b|\btop merchants?\b/.test(q)) groupBy = 'merchant'
  else if (/\b(by|per|each) (payment )?methods?\b|\bwhich (payment )?method\b/.test(q)) groupBy = 'payment_method'
  else if (/\b(by|per) status\b|\bstatus breakdown\b/.test(q)) groupBy = 'status'
  else if (/\b(by|per) (failure )?reasons?\b|\bwhy\b.*\bfail|\bfailure reasons?\b/.test(q)) groupBy = 'failure_reason'
  else if (/\b(per|by|each) hour\b|\bhourly\b|\bbusiest hour\b/.test(q)) groupBy = 'hour'
  else if (/\b(per|by|each) day\b|\bdaily\b|\btrend\b/.test(q)) groupBy = 'day'
  else if (/\b(by|per) severity\b/.test(q)) groupBy = 'severity'
  else if (/\b(by|per) type\b/.test(q)) groupBy = 'type'
  if (groupBy && ['severity', 'type'].includes(groupBy) && !['incidents', 'anomalies'].includes(entity)) groupBy = undefined
  if (groupBy && !['severity', 'type'].includes(groupBy) && entity !== 'transactions') groupBy = undefined
  if (groupBy === 'failure_reason') filters.status = ['FAILED']

  let metric: StructuredQuery['metric']
  if (/\bfailure rate\b|\bfail(ure)? %|\bhighest failure\b/.test(q)) metric = 'failure_rate'
  else if (/\bsuccess rate\b/.test(q)) metric = 'success_rate'
  else if (/\bp95\b|\b95th\b/.test(q)) metric = 'p95_latency'
  else if (/\b(latency|response time|slow(est)?)\b/.test(q)) metric = 'avg_latency'
  else if (/\b(average|avg|mean) (amount|value|ticket)\b/.test(q)) metric = 'avg_amount'
  else if (/\b(total|sum of|gross) (value|amount|volume in rs)\b|\bhow much\b|\btransaction value\b/.test(q)) metric = 'sum_amount'
  else if (/\bhow many\b|\bcount\b|\bnumber of\b|\bvolume\b|\bbusiest\b/.test(q)) metric = 'count'
  if (entity !== 'transactions' && metric && metric !== 'count') metric = entity === 'api_endpoints' && (metric === 'avg_latency' || metric === 'p95_latency') ? metric : 'count'

  const top = q.match(/\btop (\d{1,3})\b/)
  const listLimit = q.match(/\b(?:show|list|last|latest)\s+(\d{1,3})\b/)
  const limit = Math.min(200, Number(top?.[1] ?? listLimit?.[1] ?? (groupBy ? 50 : 25)))
  const mode: StructuredQuery['mode'] = groupBy || metric ? 'aggregate' : 'list'
  if (mode === 'aggregate' && !metric) metric = 'count'
  let sort: StructuredQuery['sort']
  if (mode === 'list' && entity === 'transactions') sort = /\b(largest|biggest|highest amount|top)\b/.test(q) ? { field: 'amount', dir: 'desc' } : { field: 'createdAt', dir: 'desc' }
  if (mode === 'aggregate' && groupBy && groupBy !== 'hour' && groupBy !== 'day') sort = { field: 'metric', dir: /\b(lowest|least|fewest)\b/.test(q) ? 'asc' : 'desc' }
  if (groupBy) notes.push(`Grouped by: ${groupBy.replace('_', ' ')}`)
  if (metric) notes.push(`Metric: ${metric.replace('_', ' ')}`)

  const parsed = structuredQuerySchema.safeParse({ entity, mode, metric, groupBy, range, filters, sort, limit })
  if (!parsed.success) return { ok: false, reason: 'unsupported', message: "I don't have enough data to answer that." }
  return { ok: true, query: parsed.data, interpretation: [`Entity: ${entity.replace('_', ' ')}`, ...notes] }
}
