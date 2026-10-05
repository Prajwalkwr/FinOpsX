import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import bcrypt from 'bcryptjs'
import { PrismaClient, type FailureReason, type PaymentMethod, type TxStatus } from '@prisma/client'

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') })

const prisma = new PrismaClient()
const KATHMANDU_OFFSET_MS = (5 * 60 + 45) * 60 * 1000
export const SEED_MARKER_CODE = 'DBB'

function mulberry32(seed: number) {
  let value = seed
  return () => {
    value += 0x6d2b79f5
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, items: Array<{ item: T; weight: number }>): T {
  const total = items.reduce((sum, entry) => sum + entry.weight, 0)
  let cursor = rng() * total
  for (const entry of items) {
    cursor -= entry.weight
    if (cursor <= 0) return entry.item
  }
  return items[items.length - 1].item
}

export const INSTITUTIONS = [
  { name: 'Demo Bank A', code: 'DBA', type: 'BANK', fail: 0.03, latency: 520, weight: 22 },
  { name: 'Demo Bank B', code: 'DBB', type: 'BANK', fail: 0.05, latency: 1800, weight: 20 },
  { name: 'Demo Bank C', code: 'DBC', type: 'BANK', fail: 0.035, latency: 700, weight: 18 },
  { name: 'Demo Wallet', code: 'DWL', type: 'WALLET', fail: 0.02, latency: 300, weight: 18 },
  { name: 'Demo Payment Network', code: 'DPN', type: 'PAYMENT_NETWORK', fail: 0.025, latency: 420, weight: 12 },
  { name: 'Demo Merchant Network', code: 'DMN', type: 'MERCHANT_NETWORK', fail: 0.03, latency: 600, weight: 10 },
] as const

const MERCHANTS = [
  ['Demo ABC Store', 'GROCERY'], ['Demo City Mart', 'RETAIL'], ['Demo Tech Hub', 'ELECTRONICS'], ['Demo Food House', 'FOOD'],
  ['Demo Travel Center', 'TRAVEL'], ['Demo Valley Books', 'RETAIL'], ['Demo Peak Pharmacy', 'HEALTH'], ['Demo River Cafe', 'FOOD'],
  ['Demo Hill Hardware', 'RETAIL'], ['Demo Lake Tickets', 'TRAVEL'], ['Demo Metro Fuel', 'FUEL'], ['Demo Cloud Academy', 'EDUCATION'],
  ['Demo Garden Nursery', 'RETAIL'], ['Demo Night Market', 'FOOD'], ['Demo Summit Gear', 'RETAIL'], ['Demo Lotus Clinic', 'HEALTH'],
  ['Demo Amber Jewelry', 'RETAIL'], ['Demo Quick Print', 'SERVICES'], ['Demo Harbor Fish', 'FOOD'], ['Demo Pine Furniture', 'RETAIL'],
  ['Demo Nova Electronics', 'ELECTRONICS'], ['Demo Kite Sports', 'RETAIL'], ['Demo Marble Studio', 'SERVICES'], ['Demo Fresh Basket', 'GROCERY'],
  ['Demo Orbit Mobile', 'TELECOM'],
] as const

export const SERVICES = [
  ['payment-gateway', 'Payment Gateway', 'EDGE', 'Public entry point that receives payment requests.'],
  ['merchant-api', 'Merchant API', 'EDGE', 'Merchant integrations and QR checkout.'],
  ['auth-service', 'Authentication', 'CORE', 'Issues and validates request tokens.'],
  ['payment-api', 'Payment API', 'CORE', 'Orchestrates payment authorization and status.'],
  ['settlement-service', 'Settlement', 'CORE', 'Builds and submits settlement batches.'],
  ['ai-service', 'AI Service', 'CORE', 'Operations assistant and analysis.'],
  ['bank-api', 'Bank API', 'INTEGRATION', 'Connector to the fictional demo banks.'],
  ['wallet-service', 'Wallet Service', 'INTEGRATION', 'Connector to the demo wallet.'],
  ['notification-service', 'Notification', 'INTEGRATION', 'Customer and merchant notifications.'],
  ['transaction-db', 'Transaction Database', 'DATA', 'Primary transaction store.'],
  ['redis', 'Cache (Redis)', 'DATA', 'Short-lived cache and rate limit counters.'],
] as const

export const DEPENDENCIES: Array<[string, string]> = [
  ['payment-gateway', 'auth-service'],
  ['payment-gateway', 'payment-api'],
  ['merchant-api', 'payment-api'],
  ['payment-api', 'bank-api'],
  ['payment-api', 'wallet-service'],
  ['payment-api', 'transaction-db'],
  ['payment-api', 'redis'],
  ['payment-api', 'notification-service'],
  ['wallet-service', 'transaction-db'],
  ['settlement-service', 'transaction-db'],
  ['settlement-service', 'bank-api'],
  ['settlement-service', 'notification-service'],
  ['ai-service', 'transaction-db'],
]

export const API_ENDPOINTS = [
  ['POST', '/payments', 'payment-api', 'Payment API'],
  ['GET', '/payments/:id', 'payment-api', 'Payment Status API'],
  ['POST', '/refund', 'payment-api', 'Refund API'],
  ['POST', '/settlement', 'settlement-service', 'Settlement API'],
  ['POST', '/qr/validate', 'payment-gateway', 'QR Validation API'],
  ['POST', '/bank/authorize', 'bank-api', 'Bank Authorization API'],
  ['POST', '/auth/token', 'auth-service', 'Authentication API'],
  ['POST', '/notify', 'notification-service', 'Notification API'],
] as const

const USERS = [
  ['Asha Shrestha', 'admin@finopsx.demo', 'Admin@12345', 'SUPER_ADMIN'],
  ['Rajan Thapa', 'operations@finopsx.demo', 'Operations@12345', 'OPERATIONS_MANAGER'],
  ['Maya Gurung', 'analyst@finopsx.demo', 'Analyst@12345', 'ANALYST'],
  ['Nabin KC', 'engineer@finopsx.demo', 'Engineer@12345', 'ENGINEER'],
  ['Sita Poudel', 'auditor@finopsx.demo', 'Auditor@12345', 'AUDITOR'],
] as const

const METHODS: Array<{ item: PaymentMethod; weight: number }> = [
  { item: 'QR', weight: 40 },
  { item: 'WALLET', weight: 25 },
  { item: 'BANK_TRANSFER', weight: 15 },
  { item: 'CARD', weight: 12 },
  { item: 'ACCOUNT_PAYMENT', weight: 8 },
]

const REASONS: FailureReason[] = [
  'TIMEOUT', 'BANK_API_ERROR', 'INSUFFICIENT_FUNDS', 'NETWORK_ERROR', 'INVALID_REQUEST',
  'SERVICE_UNAVAILABLE', 'DUPLICATE_TRANSACTION', 'AUTHENTICATION_FAILURE',
]

export const RESPONSE_CODE: Record<string, string> = {
  SUCCESS: '00', PENDING: '09', TIMEOUT: '68', BANK_API_ERROR: '91', INSUFFICIENT_FUNDS: '51', NETWORK_ERROR: '96',
  INVALID_REQUEST: '30', SERVICE_UNAVAILABLE: '91', DUPLICATE_TRANSACTION: '94', AUTHENTICATION_FAILURE: '55', SETTLEMENT_DELAY: '09',
}

const HOUR_WEIGHTS = [1, 1, 1, 1, 1, 2, 3, 4, 5, 7, 9, 8, 6, 5, 5, 6, 7, 8, 8, 6, 4, 3, 2, 1]

function localDayKey(date: Date) {
  return new Date(date.getTime() + KATHMANDU_OFFSET_MS).toISOString().slice(0, 10)
}

export async function seed() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to seed demo data in production. Set ALLOW_DEMO_SEED=true to override.')
  }
  const [existingUsers, marker] = await Promise.all([
    prisma.user.count(),
    prisma.institution.findUnique({ where: { code: SEED_MARKER_CODE } }),
  ])
  if (existingUsers > 0 && marker && process.env.SEED_FORCE !== 'true') {
    console.log('Demo data already present. Skipping seed.')
    return
  }
  const target = Number(process.env.SEED_TRANSACTION_COUNT ?? 20000)
  const rng = mulberry32(20261005)
  console.log(`Seeding FinOpsX synthetic data (${target} transactions)...`)

  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  if (tables.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((row) => `"${row.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`)
  }

  const roles = await Promise.all([
    prisma.role.create({ data: { name: 'SUPER_ADMIN', description: 'Full platform control' } }),
    prisma.role.create({ data: { name: 'OPERATIONS_MANAGER', description: 'Transactions, incidents, analytics, reports, institutions' } }),
    prisma.role.create({ data: { name: 'ANALYST', description: 'Analytics, transactions, reports, anomalies' } }),
    prisma.role.create({ data: { name: 'ENGINEER', description: 'System health, APIs, incidents, services' } }),
    prisma.role.create({ data: { name: 'AUDITOR', description: 'Read-only access and audit logs' } }),
  ])
  const roleId = Object.fromEntries(roles.map((role) => [role.name, role.id]))
  const users = []
  for (const [name, email, password, role] of USERS) {
    users.push(await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash(password, 10), roleId: roleId[role], lastLoginAt: new Date(Date.now() - 3600_000) },
    }))
  }
  const admin = users[0]
  const engineer = users[3]

  await prisma.thresholdConfig.create({ data: { id: 'default' } })
  await prisma.simulatorConfig.create({ data: { id: 'default', running: false, tpm: 60 } })
  for (const cadence of ['DAILY', 'WEEKLY', 'MONTHLY'] as const) {
    await prisma.reportSchedule.create({ data: { cadence, enabled: cadence === 'DAILY', deliveryStatus: 'EMAIL_DISABLED', nextRunAt: new Date(Date.now() + 86400_000) } })
  }

  const institutions = []
  for (const item of INSTITUTIONS) {
    institutions.push(await prisma.institution.create({ data: { name: item.name, code: item.code, type: item.type } }))
  }
  const instByCode = Object.fromEntries(institutions.map((item) => [item.code, item]))
  const profile = Object.fromEntries(INSTITUTIONS.map((item) => [item.code, item]))
  const merchants = []
  for (let i = 0; i < MERCHANTS.length; i += 1) {
    const [name, category] = MERCHANTS[i]
    merchants.push(await prisma.merchant.create({ data: { name, code: `M${String(i + 1).padStart(3, '0')}`, category } }))
  }

  const services = []
  for (const [key, name, layer, description] of SERVICES) {
    services.push(await prisma.service.create({ data: { key, name, layer, description, simulated: true, responseTimeMs: key === 'bank-api' ? 1800 : 140 } }))
  }
  const serviceByKey = Object.fromEntries(services.map((service) => [service.key, service]))
  await prisma.serviceDependency.createMany({
    data: DEPENDENCIES.map(([from, to]) => ({ fromServiceId: serviceByKey[from].id, toServiceId: serviceByKey[to].id })),
  })
  const endpoints = []
  for (const [method, endpoint, key, name] of API_ENDPOINTS) {
    endpoints.push(await prisma.apiEndpoint.create({
      data: { serviceId: serviceByKey[key].id, method, endpoint, name, latencyMs: 0, rpm: 0, errorRate: 0, p95Ms: 0, p99Ms: 0, availability: 100 },
    }))
  }
  const endpointByKey = Object.fromEntries(endpoints.map((row) => [`${row.method} ${row.endpoint}`, row]))

  type Row = Record<string, unknown> & { id: string; createdAt: Date; status: TxStatus; amount: number; institutionId: string; transactionId: string; responseTimeMs: number; paymentMethod: PaymentMethod; failureReason: FailureReason | null; notificationStatus: string }
  const rows: Row[] = []
  const now = new Date()
  const today = localDayKey(now)
  const bankCodes = ['DBA', 'DBB', 'DBC']
  let lastCorrelation = 'cor_seed_0'
  for (let i = 0; i < target; i += 1) {
    const dayOffset = Math.floor(rng() * 30)
    const hour = pick(rng, HOUR_WEIGHTS.map((weight, index) => ({ item: index, weight })))
    const minute = Math.floor(rng() * 60)
    const localUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, Math.floor(rng() * 60))
    let createdAt = new Date(localUtc - KATHMANDU_OFFSET_MS - dayOffset * 86400_000)
    if (createdAt > now) createdAt = new Date(createdAt.getTime() - 86400_000)
    const institution = pick(rng, INSTITUTIONS.map((item) => ({ item, weight: item.weight })))
    const inst = instByCode[institution.code]
    const merchant = merchants[Math.floor(rng() * merchants.length)]
    const method = pick(rng, METHODS)
    const spike = merchant.code === 'M001' && hour >= 11 && hour <= 13 && dayOffset === 1
    const amount = spike ? Math.round(70000 + rng() * 50000) : rng() < 0.008 ? Math.round(100000 + rng() * 80000) : Math.round(100 + Math.pow(rng(), 2) * 9000)
    const roll = rng()
    const failBias = profile[institution.code].fail
    let status: TxStatus = 'SUCCESS'
    if (roll < failBias) status = 'FAILED'
    else if (roll < failBias + 0.012) status = now.getTime() - createdAt.getTime() < 15 * 60_000 ? 'PENDING' : 'FAILED'
    else if (roll > 0.996) status = 'REVERSED'
    else if (roll > 0.993) status = 'REFUNDED'
    const timedOut = status === 'FAILED' && roll >= failBias
    const failureReason: FailureReason | null = timedOut ? 'TIMEOUT' : status === 'FAILED' ? REASONS[Math.floor(rng() * REASONS.length)] : null
    const responseTimeMs = failureReason === 'TIMEOUT'
      ? 8000 + Math.round(rng() * 400)
      : Math.round(profile[institution.code].latency * (status === 'FAILED' ? 2.2 : 0.75 + rng() * 0.5))
    const destination = method === 'BANK_TRANSFER'
      ? instByCode[bankCodes.filter((code) => code !== institution.code)[Math.floor(rng() * 2)] ?? 'DBA']
      : method === 'WALLET' ? instByCode.DWL : instByCode.DMN
    const authAt = new Date(createdAt.getTime() + 30 + Math.round(rng() * 40))
    const processedAt = new Date(createdAt.getTime() + responseTimeMs)
    const correlationId = rng() < 0.003 ? lastCorrelation : `cor_seed_${i}`
    lastCorrelation = correlationId
    const outcomeCode = status === 'FAILED' ? RESPONSE_CODE[failureReason ?? 'BANK_API_ERROR'] : status === 'PENDING' ? '09' : '00'
    rows.push({
      id: crypto.randomUUID(),
      transactionId: `TXN${String(10000000 + i)}`,
      customerId: rng() < 0.002 ? 'CUS-UNKNOWN' : `CUS-******${String(100 + (i % 900)).padStart(3, '0')}`,
      merchantId: merchant.id,
      merchantReference: rng() < 0.004 ? null : `ORD-${merchant.code}-${String(i).padStart(6, '0')}`,
      institutionId: inst.id,
      destinationInstitutionId: destination?.id ?? null,
      amount,
      currency: 'NPR',
      paymentMethod: method,
      serviceKey: 'payment-api',
      status,
      lifecycleStage: status === 'PENDING' ? 'OUTCOME' : status === 'SUCCESS' ? 'SETTLEMENT' : 'COMPLETED',
      responseCode: rng() < 0.002 ? null : outcomeCode,
      responseTimeMs,
      riskScore: Math.min(99, Math.round((amount > 100000 ? 75 : 8) + rng() * 20)),
      failureReason: status === 'FAILED' && rng() < 0.01 ? null : failureReason,
      settlementStatus: status === 'SUCCESS' ? 'QUEUED' : 'NOT_STARTED',
      notificationStatus: status === 'FAILED' && rng() < 0.1 ? 'FAILED' : 'SENT',
      correlationId,
      apiEndpoint: 'POST /payments',
      suspicious: amount >= 100000,
      initiatedAt: createdAt,
      authenticatedAt: authAt,
      processedAt,
      completedAt: status === 'PENDING' ? null : processedAt,
      createdAt,
      updatedAt: processedAt,
    })
  }

  const settlements: Array<{ id: string; publicId: string; institutionId: string; status: 'SETTLED'; transactionCount: number; amount: number; expectedAt: Date; settledAt: Date; createdAt: Date }> = []
  const batches = new Map<string, Row[]>()
  for (const row of rows) {
    if (row.status !== 'SUCCESS') continue
    const day = localDayKey(row.createdAt)
    if (day === today) continue
    if (rng() < 0.001) {
      row.settlementStatus = 'DELAYED'
      continue
    }
    const key = `${row.institutionId}|${day}`
    batches.set(key, [...(batches.get(key) ?? []), row])
  }
  let batchNo = 1
  for (const [key, members] of [...batches.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [institutionId, day] = key.split('|')
    const settledAt = new Date(new Date(`${day}T18:00:00.000Z`).getTime() - KATHMANDU_OFFSET_MS)
    const id = crypto.randomUUID()
    settlements.push({
      id,
      publicId: `STL-${String(batchNo++).padStart(5, '0')}`,
      institutionId,
      status: 'SETTLED',
      transactionCount: members.length,
      amount: members.reduce((sum, row) => sum + row.amount, 0),
      expectedAt: settledAt,
      settledAt,
      createdAt: settledAt,
    })
    for (const row of members) {
      row.status = 'SETTLED'
      row.settlementStatus = 'SETTLED'
      row.settlementId = id
      row.settledAt = settledAt
      row.lifecycleStage = 'COMPLETED'
    }
  }
  if (settlements.length) await prisma.settlement.createMany({ data: settlements.map((row) => ({ ...row, amount: row.amount.toFixed(2) })) })

  const chunk = 2000
  for (let i = 0; i < rows.length; i += chunk) {
    await prisma.transaction.createMany({ data: rows.slice(i, i + chunk).map((row) => ({ ...row, amount: row.amount.toFixed(2) })) as never })
    console.log(`  transactions ${Math.min(i + chunk, rows.length)}/${rows.length}`)
  }

  const ledger: Array<Record<string, unknown>> = []
  for (const row of rows) {
    if (!['SUCCESS', 'SETTLED', 'REVERSED', 'REFUNDED'].includes(row.status)) continue
    const roll = rng()
    if (roll < 0.0012) continue
    const amount = roll < 0.0018 ? Math.max(1, row.amount - 500) : row.amount
    ledger.push({ institutionId: row.institutionId, transactionRef: row.transactionId, transactionId: row.id, amount: amount.toFixed(2), status: row.status === 'SETTLED' ? 'SUCCESS' : row.status, recordedAt: new Date(row.createdAt.getTime() + 2000) })
  }
  const orphanCount = Math.max(2, Math.round(rows.length * 0.0002))
  for (let i = 0; i < orphanCount; i += 1) {
    const inst = institutions[i % institutions.length]
    ledger.push({ institutionId: inst.id, transactionRef: `EXT-${inst.code}-${1000 + i}`, transactionId: null, amount: (500 + Math.round(rng() * 4000)).toFixed(2), status: 'SUCCESS', recordedAt: new Date(now.getTime() - Math.round(rng() * 20) * 3600_000) })
  }
  for (let i = 0; i < ledger.length; i += chunk) await prisma.institutionLedgerEntry.createMany({ data: ledger.slice(i, i + chunk) as never })

  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const events = sorted.slice(0, 800).flatMap((tx) => lifecycleEvents(tx))
  for (let i = 0; i < events.length; i += chunk) await prisma.transactionEvent.createMany({ data: events.slice(i, i + chunk) })

  const recentWindow = now.getTime() - 6 * 3600_000
  const calls = sorted.filter((tx) => tx.createdAt.getTime() >= recentWindow).flatMap((tx) => apiCallsFor(tx, endpointByKey, rng))
  for (let i = 0; i < calls.length; i += chunk) await prisma.apiCall.createMany({ data: calls.slice(i, i + chunk) })

  const bankB = instByCode.DBB
  const bankC = instByCode.DBC
  const incidentSeeds = [
    ['INC-2041', 'Bank API latency above threshold', 'Bank API latency for Demo Bank B rose above the demo threshold.', 'HIGH', 'POST_INCIDENT_REVIEW', 'LATENCY', bankB.id, 'bank-api', 'Platform Engineering'],
    ['INC-2042', 'Settlement delay', 'Settlement batches queued longer than the normal window.', 'MEDIUM', 'RESOLVED', 'SETTLEMENT', bankC.id, 'settlement-service', 'Settlement Operations'],
    ['INC-2043', 'Repeated transaction failures', 'Failure concentration on Demo Bank B.', 'HIGH', 'RESOLVED', 'FAILURE_SPIKE', bankB.id, 'payment-api', 'Payments Operations'],
    ['INC-2044', 'Notification service degradation', 'Notification delivery slowed for a short window.', 'LOW', 'RESOLVED', 'NOTIFICATION', instByCode.DWL.id, 'notification-service', 'Platform Engineering'],
  ] as const
  for (const [publicId, title, description, severity, status, incidentType, institutionId, serviceKey, team] of incidentSeeds) {
    const detected = new Date(Date.now() - 3 * 86400_000)
    await prisma.incident.create({
      data: {
        publicId, title, description, severity, status, incidentType, team,
        affectedTransactionCount: 120 + Math.floor(rng() * 400),
        detectedAt: detected,
        acknowledgedAt: new Date(detected.getTime() + 4 * 60_000),
        resolvedAt: new Date(detected.getTime() + 50 * 60_000),
        rootCause: 'Synthetic demonstration cause. No live banking system was contacted.',
        resolution: 'Service returned to the normal simulated range.',
        preventiveAction: 'Add an earlier latency alert for the affected connector.',
        aiSummary: `${title}. AI-generated analysis — verify before taking operational action. This is synthetic demo data.`,
        assigneeId: engineer.id,
        institutions: { create: [{ institutionId }] },
        services: { create: [{ serviceId: serviceByKey[serviceKey].id }] },
        events: {
          create: [
            { kind: 'STATUS', message: 'Incident detected from failure-rate rule.', createdAt: detected, actorEmail: 'system@finopsx.demo' },
            { kind: 'STATUS', message: 'Status changed from DETECTED to ACKNOWLEDGED.', createdAt: new Date(detected.getTime() + 4 * 60_000), actorEmail: admin.email },
            { kind: 'ASSIGNMENT', message: 'Assigned to Nabin KC.', createdAt: new Date(detected.getTime() + 6 * 60_000), actorEmail: admin.email },
            { kind: 'NOTE', message: 'Connector latency confirmed in the API dashboard.', createdAt: new Date(detected.getTime() + 20 * 60_000), actorEmail: engineer.email },
            { kind: 'STATUS', message: 'Status changed from MITIGATING to RESOLVED.', createdAt: new Date(detected.getTime() + 50 * 60_000), actorEmail: engineer.email },
          ],
        },
      },
    })
  }

  const anomalySeeds = [
    ['ANM-3101', 'HIGH_VALUE_SPIKE', 'HIGH', 'High-value transaction spike', 'Demo ABC Store hourly value moved well above its recent window.', 'z-score', 0.94, bankB.id, merchants[0].id, 'MERCHANT', merchants[0].name, 18000, 96000],
    ['ANM-3102', 'MERCHANT_VOLUME_SPIKE', 'MEDIUM', 'Unusual merchant volume', 'Demo City Mart volume jumped against its moving average.', 'moving-average', 0.81, instByCode.DBA.id, merchants[1].id, 'MERCHANT', merchants[1].name, 14, 41],
    ['ANM-3103', 'FAILURE_RATE_SPIKE', 'HIGH', 'Failure-rate spike', 'Demo Bank B concentrated a burst of failed payments.', 'z-score', 0.9, bankB.id, null, 'INSTITUTION', bankB.name, 5.1, 17.8],
    ['ANM-3104', 'API_LATENCY_SPIKE', 'HIGH', 'API latency spike', 'Bank API latency moved outside the recent baseline.', 'threshold', 0.88, bankB.id, null, 'API', 'POST /bank/authorize', 1800, 7400],
    ['ANM-3105', 'SETTLEMENT_DELAY', 'MEDIUM', 'Settlement delay', 'Successful payments waited longer than the settlement window.', 'threshold', 0.76, bankC.id, null, 'INSTITUTION', bankC.name, 0, 12],
  ] as const
  for (const [publicId, type, severity, title, description, method, score, institutionId, merchantId, entityType, entityName, normalValue, observedValue] of anomalySeeds) {
    await prisma.anomaly.create({
      data: { publicId, type, severity, title, description, method, score, institutionId, merchantId, entityType, entityName, normalValue, observedValue, status: 'RESOLVED', detectedAt: new Date(Date.now() - 3 * 86400_000), evidence: { synthetic: true, seeded: true } },
    })
  }

  await prisma.auditLog.createMany({
    data: [
      { userId: admin.id, actorEmail: admin.email, action: 'LOGIN', resource: 'AUTH', resourceId: admin.id, ipAddress: '127.0.0.1', userAgent: 'seed' },
      { userId: admin.id, actorEmail: admin.email, action: 'THRESHOLDS_UPDATED', resource: 'SETTINGS', resourceId: 'thresholds', previousValue: { failureRatePct: 4 }, newValue: { failureRatePct: 5 } },
    ],
  })
  await prisma.notification.createMany({
    data: [
      { userId: admin.id, type: 'INCIDENT', title: 'Historical incident seeded', message: 'Bank API latency above threshold is available for review.', severity: 'HIGH', link: '/incidents/INC-2041' },
      { userId: engineer.id, type: 'INCIDENT', title: 'Historical incident seeded', message: 'Repeated transaction failures on Demo Bank B.', severity: 'HIGH', link: '/incidents/INC-2043' },
    ],
  })
  for (let i = 0; i < 48; i += 1) {
    await prisma.systemMetric.create({
      data: { recordedAt: new Date(Date.now() - i * 3600_000), cpu: 22 + (i % 7), memory: 40 + (i % 5), dbConnections: 12 + (i % 4), redisUp: false, queueLength: i % 3, healthScore: 92, storageMb: 48 + i * 0.1, slowQueries: i % 4, replicationLagMs: 40 + (i % 6) * 10, cacheUsagePct: 31 + (i % 5), processMemoryMb: 120, eventLoopLagMs: 3, simulated: true },
    })
  }
  console.log('Seed complete. Demo passwords are for local development only.')
}

type SeedTx = { id: string; createdAt: Date; status: TxStatus; responseTimeMs: number; failureReason: FailureReason | null; settledAt?: unknown }

function lifecycleEvents(tx: SeedTx) {
  const at = (ms: number) => new Date(tx.createdAt.getTime() + ms)
  const outcome = tx.status === 'FAILED' ? 'FAILED' : tx.status === 'PENDING' ? 'PENDING' : 'SUCCESS'
  const events = [
    { service: 'Payment Gateway', event: 'INITIATED', status: 'OK', createdAt: at(0) },
    { service: 'Authentication', event: 'AUTHENTICATING', status: tx.failureReason === 'AUTHENTICATION_FAILURE' ? 'FAILED' : 'OK', createdAt: at(40) },
    { service: 'Payment API', event: 'PROCESSING', status: 'OK', createdAt: at(90) },
    { service: 'Bank API', event: outcome, status: outcome, createdAt: at(tx.responseTimeMs) },
  ]
  if (tx.status === 'SETTLED' && tx.settledAt instanceof Date) {
    events.push({ service: 'Settlement', event: 'SETTLEMENT', status: 'SETTLED', createdAt: tx.settledAt })
    events.push({ service: 'Settlement', event: 'COMPLETED', status: 'OK', createdAt: new Date(tx.settledAt.getTime() + 1000) })
  } else if (tx.status === 'SUCCESS') {
    events.push({ service: 'Settlement', event: 'SETTLEMENT', status: 'QUEUED', createdAt: at(tx.responseTimeMs + 50) })
  } else if (tx.status !== 'PENDING') {
    events.push({ service: 'Payment API', event: 'COMPLETED', status: outcome, createdAt: at(tx.responseTimeMs + 30) })
  }
  return events.map((event) => ({ transactionId: tx.id, ...event }))
}

function statusCodeFor(tx: { status: TxStatus; failureReason: FailureReason | null }) {
  if (tx.status === 'PENDING') return 202
  if (tx.status !== 'FAILED') return 201
  switch (tx.failureReason) {
    case 'TIMEOUT': return 504
    case 'BANK_API_ERROR': return 502
    case 'INSUFFICIENT_FUNDS': return 402
    case 'INVALID_REQUEST': return 400
    case 'DUPLICATE_TRANSACTION': return 409
    case 'AUTHENTICATION_FAILURE': return 401
    default: return 503
  }
}

function apiCallsFor(tx: { createdAt: Date; status: TxStatus; failureReason: FailureReason | null; responseTimeMs: number; paymentMethod: PaymentMethod; institutionId: string; transactionId: string; notificationStatus: string }, endpoints: Record<string, { id: string }>, rng: () => number) {
  const base = { institutionId: tx.institutionId, transactionRef: tx.transactionId }
  const calls = [
    { endpointId: endpoints['POST /auth/token'].id, statusCode: tx.failureReason === 'AUTHENTICATION_FAILURE' ? 401 : 200, latencyMs: Math.round(30 + rng() * 40), createdAt: tx.createdAt, ...base },
  ]
  if (tx.paymentMethod === 'QR') calls.push({ endpointId: endpoints['POST /qr/validate'].id, statusCode: 200, latencyMs: Math.round(60 + rng() * 60), createdAt: new Date(tx.createdAt.getTime() + 40), ...base })
  if (tx.paymentMethod !== 'WALLET') {
    const code = tx.failureReason === 'TIMEOUT' ? 504 : tx.failureReason === 'BANK_API_ERROR' ? 502 : 200
    calls.push({ endpointId: endpoints['POST /bank/authorize'].id, statusCode: code, latencyMs: Math.round(tx.responseTimeMs * 0.8), createdAt: new Date(tx.createdAt.getTime() + 90), ...base })
  }
  calls.push({ endpointId: endpoints['POST /payments'].id, statusCode: statusCodeFor(tx), latencyMs: tx.responseTimeMs, createdAt: tx.createdAt, ...base })
  if (rng() < 0.3) calls.push({ endpointId: endpoints['GET /payments/:id'].id, statusCode: 200, latencyMs: Math.round(40 + rng() * 60), createdAt: new Date(tx.createdAt.getTime() + tx.responseTimeMs + 500), ...base })
  calls.push({ endpointId: endpoints['POST /notify'].id, statusCode: tx.notificationStatus === 'FAILED' ? 503 : 200, latencyMs: Math.round(70 + rng() * 60), createdAt: new Date(tx.createdAt.getTime() + tx.responseTimeMs + 80), ...base })
  if (tx.status === 'REVERSED' || tx.status === 'REFUNDED') calls.push({ endpointId: endpoints['POST /refund'].id, statusCode: 200, latencyMs: Math.round(200 + rng() * 200), createdAt: new Date(tx.createdAt.getTime() + 60_000), ...base })
  return calls
}

const entry = process.argv[1]?.replace(/\\/g, '/')
if (entry?.includes('prisma/seed') || entry?.endsWith('/seed.js')) {
  seed()
    .then(() => prisma.$disconnect())
    .catch(async (error) => {
      console.error(error)
      await prisma.$disconnect()
      process.exit(1)
    })
}
