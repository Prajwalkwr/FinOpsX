import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import bcrypt from 'bcryptjs'
import { PrismaClient, type PaymentMethod, type TxStatus, type FailureReason } from '@prisma/client'

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') })

const prisma = new PrismaClient()
const KATHMANDU_OFFSET_MS = (5 * 60 + 45) * 60 * 1000

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

const INSTITUTIONS = [
  { name: 'Himalayan Demo Bank', code: 'HDB', type: 'BANK', fail: 0.09, latency: 980 },
  { name: 'Everest Demo Bank', code: 'EDB', type: 'BANK', fail: 0.035, latency: 520 },
  { name: 'Kathmandu Demo Bank', code: 'KDB', type: 'BANK', fail: 0.055, latency: 2100 },
  { name: 'Lumbini Demo Finance', code: 'LDF', type: 'FINANCE', fail: 0.03, latency: 640 },
  { name: 'Sagarmatha Demo Bank', code: 'SDB', type: 'BANK', fail: 0.025, latency: 470 },
]

const MERCHANTS = [
  ['Demo ABC Store', 'GROCERY'],
  ['Demo City Mart', 'RETAIL'],
  ['Demo Tech Hub', 'ELECTRONICS'],
  ['Demo Food House', 'FOOD'],
  ['Demo Travel Center', 'TRAVEL'],
  ['Demo Valley Books', 'RETAIL'],
  ['Demo Peak Pharmacy', 'HEALTH'],
  ['Demo River Cafe', 'FOOD'],
  ['Demo Hill Hardware', 'RETAIL'],
  ['Demo Lake Tickets', 'TRAVEL'],
  ['Demo Metro Fuel', 'FUEL'],
  ['Demo Cloud Academy', 'EDUCATION'],
  ['Demo Garden Nursery', 'RETAIL'],
  ['Demo Night Market', 'FOOD'],
  ['Demo Summit Gear', 'RETAIL'],
  ['Demo Lotus Clinic', 'HEALTH'],
  ['Demo Amber Jewelry', 'RETAIL'],
  ['Demo Quick Print', 'SERVICES'],
  ['Demo Harbor Fish', 'FOOD'],
  ['Demo Pine Furniture', 'RETAIL'],
  ['Demo Nova Electronics', 'ELECTRONICS'],
  ['Demo Kite Sports', 'RETAIL'],
  ['Demo Marble Studio', 'SERVICES'],
  ['Demo Fresh Basket', 'GROCERY'],
  ['Demo Orbit Mobile', 'TELECOM'],
] as const

const SERVICES = [
  ['payment-switch', 'Payment Switch'],
  ['wallet-service', 'Wallet Service'],
  ['banking-api', 'Banking API'],
  ['merchant-api', 'Merchant API'],
  ['notification-service', 'Notification Service'],
  ['settlement-service', 'Settlement Service'],
  ['transaction-processor', 'Transaction Processor'],
  ['database', 'Database'],
  ['redis', 'Redis'],
  ['ai-service', 'AI Service'],
] as const

const APIS = [
  ['POST', '/api/payments', 'banking-api', 1800, 10820, 2.1],
  ['POST', '/api/wallets/transfer', 'wallet-service', 420, 6400, 0.8],
  ['POST', '/api/switch/authorize', 'payment-switch', 120, 12100, 0.4],
  ['POST', '/api/merchants/charge', 'merchant-api', 260, 4300, 0.9],
  ['POST', '/api/notify/send', 'notification-service', 90, 2200, 0.3],
  ['POST', '/api/settlements/batch', 'settlement-service', 640, 180, 1.2],
  ['GET', '/api/banks/status', 'banking-api', 140, 900, 0.2],
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
  { item: 'MOBILE_BANKING', weight: 8 },
]

const REASONS: FailureReason[] = [
  'TIMEOUT',
  'BANK_API_ERROR',
  'INSUFFICIENT_FUNDS',
  'NETWORK_ERROR',
  'INVALID_REQUEST',
  'SERVICE_UNAVAILABLE',
  'DUPLICATE_TRANSACTION',
  'AUTHENTICATION_FAILURE',
  'SETTLEMENT_DELAY',
]

const HOUR_WEIGHTS = [1, 1, 1, 1, 1, 2, 3, 4, 5, 7, 9, 8, 6, 5, 5, 6, 7, 8, 8, 6, 4, 3, 2, 1]

export async function seed() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to seed demo data in production. Set ALLOW_DEMO_SEED=true to override.')
  }
  const existingUsers = await prisma.user.count()
  if (existingUsers > 0 && process.env.SEED_FORCE !== 'true') {
    console.log('Demo data already present. Skipping seed.')
    return
  }
  const target = Number(process.env.SEED_TRANSACTION_COUNT ?? 20000)
  const rng = mulberry32(20261004)
  console.log(`Seeding FinOpsX synthetic data (${target} transactions)...`)

  await prisma.idempotencyKey.deleteMany()
  await prisma.aiMessage.deleteMany()
  await prisma.aiConversation.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.auditLog.deleteMany()
  await prisma.report.deleteMany()
  await prisma.anomaly.deleteMany()
  await prisma.incidentEvent.deleteMany()
  await prisma.incidentService.deleteMany()
  await prisma.incidentInstitution.deleteMany()
  await prisma.incident.deleteMany()
  await prisma.transactionEvent.deleteMany()
  await prisma.transaction.deleteMany()
  await prisma.apiMetric.deleteMany()
  await prisma.systemMetric.deleteMany()
  await prisma.service.deleteMany()
  await prisma.merchant.deleteMany()
  await prisma.institution.deleteMany()
  await prisma.refreshToken.deleteMany()
  await prisma.passwordReset.deleteMany()
  await prisma.reportSchedule.deleteMany()
  await prisma.simulatorConfig.deleteMany()
  await prisma.thresholdConfig.deleteMany()
  await prisma.user.deleteMany()
  await prisma.role.deleteMany()

  const roles = await Promise.all([
    prisma.role.create({ data: { name: 'SUPER_ADMIN', description: 'Full platform control' } }),
    prisma.role.create({ data: { name: 'OPERATIONS_MANAGER', description: 'Runs incidents, reports, and investigations' } }),
    prisma.role.create({ data: { name: 'ANALYST', description: 'Reads analytics, anomalies, and reports' } }),
    prisma.role.create({ data: { name: 'ENGINEER', description: 'Handles health, failures, and incidents' } }),
    prisma.role.create({ data: { name: 'AUDITOR', description: 'Read-only review of operational records' } }),
  ])
  const roleId = Object.fromEntries(roles.map((role) => [role.name, role.id]))
  const users = []
  for (const [name, email, password, role] of USERS) {
    users.push(await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        roleId: roleId[role],
        lastLoginAt: new Date(Date.now() - 3600_000),
      },
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
    institutions.push(await prisma.institution.create({ data: { name: item.name, code: item.code, type: item.type, status: item.code === 'KDB' ? 'DEGRADED' : 'OPERATIONAL' } }))
  }
  const merchants = []
  for (let i = 0; i < MERCHANTS.length; i += 1) {
    const [name, category] = MERCHANTS[i]
    merchants.push(await prisma.merchant.create({ data: { name, code: `M${String(i + 1).padStart(3, '0')}`, category } }))
  }
  const services = []
  for (const [key, name] of SERVICES) {
    services.push(await prisma.service.create({
      data: {
        key,
        name,
        status: key === 'banking-api' ? 'DEGRADED' : 'OPERATIONAL',
        responseTimeMs: key === 'banking-api' ? 1800 : key === 'settlement-service' ? 340 : 140,
        uptime: key === 'banking-api' ? 99.2 : 99.95,
        simulated: true,
      },
    }))
  }
  const serviceByKey = Object.fromEntries(services.map((service) => [service.key, service]))
  for (const [method, endpoint, key, latency, rpm, errorRate] of APIS) {
    await prisma.apiMetric.create({
      data: {
        serviceId: serviceByKey[key].id,
        method,
        endpoint,
        latencyMs: latency,
        rpm,
        errorRate,
        p95Ms: Math.round(latency * 1.8),
        p99Ms: Math.round(latency * 2.6),
        availability: 100 - errorRate,
        status: errorRate > 2 ? 'DEGRADED' : 'OPERATIONAL',
      },
    })
  }

  const instByCode = Object.fromEntries(institutions.map((item) => [item.code, item]))
  const profile = Object.fromEntries(INSTITUTIONS.map((item) => [item.code, item]))
  const rows: Array<Record<string, unknown>> = []
  const now = new Date()
  for (let i = 0; i < target; i += 1) {
    const dayOffset = Math.floor(rng() * 30)
    const hour = pick(rng, HOUR_WEIGHTS.map((weight, index) => ({ item: index, weight })))
    const minute = Math.floor(rng() * 60)
    const localUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, Math.floor(rng() * 60))
    const createdAt = new Date(localUtc - KATHMANDU_OFFSET_MS - dayOffset * 86400_000)
    const institution = pick(rng, INSTITUTIONS.map((item) => ({ item, weight: item.code === 'HDB' ? 24 : 19 })))
    const inst = instByCode[institution.code]
    const merchant = merchants[Math.floor(rng() * merchants.length)]
    const method = pick(rng, METHODS)
    const spike = merchant.code === 'M001' && hour >= 11 && hour <= 13 && dayOffset === 1
    const amount = spike ? Math.round(70000 + rng() * 50000) : rng() < 0.008 ? Math.round(100000 + rng() * 80000) : Math.round(100 + Math.pow(rng(), 2) * 9000)
    const failBias = profile[institution.code].fail
    const roll = rng()
    let status: TxStatus = 'SUCCESS'
    if (roll < failBias) status = 'FAILED'
    else if (roll < failBias + 0.02) status = 'PENDING'
    else if (roll > 0.995) status = 'CANCELLED'
    else if (roll > 0.992) status = 'REFUNDED'
    const failureReason = status === 'FAILED' ? REASONS[Math.floor(rng() * (institution.code === 'KDB' ? 3 : REASONS.length))] : null
    rows.push({
      transactionId: `TXN${String(10000000 + i)}`,
      customerId: `CUS-******${String(100 + (i % 900)).padStart(3, '0')}`,
      merchantId: merchant.id,
      institutionId: inst.id,
      amount: amount.toFixed(2),
      currency: 'NPR',
      paymentMethod: method,
      status,
      responseTimeMs: Math.round(profile[institution.code].latency * (status === 'FAILED' ? 2.4 : 0.75 + rng() * 0.5)),
      riskScore: Math.min(99, Math.round((amount > 100000 ? 75 : 8) + rng() * 20)),
      failureReason,
      settlementStatus: status === 'SUCCESS' ? 'SETTLED' : status === 'PENDING' ? 'QUEUED' : 'NOT_STARTED',
      notificationStatus: status === 'FAILED' && rng() < 0.1 ? 'FAILED' : 'SENT',
      correlationId: `cor_seed_${i}`,
      apiEndpoint: 'POST /api/payments',
      suspicious: amount >= 100000,
      createdAt,
      updatedAt: createdAt,
    })
  }
  const chunk = 2000
  for (let i = 0; i < rows.length; i += chunk) {
    await prisma.transaction.createMany({ data: rows.slice(i, i + chunk) as never })
    console.log(`  transactions ${Math.min(i + chunk, rows.length)}/${rows.length}`)
  }

  const recent = await prisma.transaction.findMany({ orderBy: { createdAt: 'desc' }, take: 800, select: { id: true, createdAt: true, status: true } })
  const events = recent.flatMap((tx) => ['Request received', 'Bank authentication', 'Payment processing', 'Bank response', 'Transaction completed', 'Settlement queued'].map((event, index) => ({
    transactionId: tx.id,
    service: index < 2 ? 'Banking API' : index === 5 ? 'Settlement Service' : 'Transaction Processor',
    event,
    status: tx.status === 'FAILED' && index === 3 ? 'FAILED' : 'OK',
    createdAt: new Date(tx.createdAt.getTime() + index * 40),
  })))
  for (let i = 0; i < events.length; i += 2000) {
    await prisma.transactionEvent.createMany({ data: events.slice(i, i + 2000) })
  }

  const himalayan = instByCode.HDB
  const kathmandu = instByCode.KDB
  const incidentSeeds = [
    ['INC-2041', 'Payment API latency', 'Banking API latency rose above the demo threshold.', 'HIGH', 'RESOLVED', 'LATENCY', kathmandu.id, 'banking-api'],
    ['INC-2042', 'Settlement delay', 'Settlement batches queued longer than the normal window.', 'MEDIUM', 'CLOSED', 'SETTLEMENT', himalayan.id, 'settlement-service'],
    ['INC-2043', 'Repeated transaction failures', 'Failure concentration on a fictional demo bank.', 'HIGH', 'RESOLVED', 'FAILURE_SPIKE', himalayan.id, 'payment-switch'],
    ['INC-2044', 'Notification service degradation', 'Notification delivery slowed for a short window.', 'LOW', 'RESOLVED', 'NOTIFICATION', kathmandu.id, 'notification-service'],
  ] as const
  for (const [publicId, title, description, severity, status, incidentType, institutionId, serviceKey] of incidentSeeds) {
    const detected = new Date(Date.now() - 3 * 86400_000)
    await prisma.incident.create({
      data: {
        publicId,
        title,
        description,
        severity,
        status,
        incidentType,
        affectedTransactionCount: 120 + Math.floor(rng() * 400),
        detectedAt: detected,
        resolvedAt: status === 'OPEN' ? null : new Date(detected.getTime() + 50 * 60_000),
        rootCause: 'Synthetic demonstration cause. No live banking system was contacted.',
        resolution: 'Service returned to the normal simulated range.',
        aiSummary: `${title}. AI-generated analysis — verify before taking operational action. This is synthetic demo data.`,
        assigneeId: engineer.id,
        institutions: { create: [{ institutionId }] },
        services: { create: [{ serviceId: serviceByKey[serviceKey].id }] },
        events: {
          create: [
            { message: 'Failure rate increased.', createdAt: detected, actorEmail: 'system@finopsx.demo' },
            { message: 'Anomaly detected.', createdAt: new Date(detected.getTime() + 2 * 60_000), actorEmail: 'system@finopsx.demo' },
            { message: 'Engineer assigned.', createdAt: new Date(detected.getTime() + 6 * 60_000), actorEmail: admin.email },
            { message: 'Service recovered.', createdAt: new Date(detected.getTime() + 40 * 60_000), actorEmail: 'system@finopsx.demo' },
            { message: 'Incident resolved.', createdAt: new Date(detected.getTime() + 50 * 60_000), actorEmail: engineer.email },
          ],
        },
      },
    })
  }

  const anomalySeeds = [
    ['ANM-3101', 'HIGH_VALUE_SPIKE', 'HIGH', 'High-value transaction spike', 'Demo ABC Store hourly value moved well above its recent window.', 'z-score', 0.94, himalayan.id, merchants[0].id],
    ['ANM-3102', 'MERCHANT_ACTIVITY_ANOMALY', 'MEDIUM', 'Merchant volume spike', 'Demo City Mart volume jumped against its moving average.', 'moving-average', 0.81, instByCode.EDB.id, merchants[1].id],
    ['ANM-3103', 'BANK_FAILURE_SPIKE', 'HIGH', 'Bank failure spike', 'Himalayan Demo Bank concentrated a burst of failed payments.', 'rule', 0.9, himalayan.id, null],
    ['ANM-3104', 'API_LATENCY_ANOMALY', 'HIGH', 'API latency anomaly', 'Banking API latency moved outside the recent baseline.', 'rule', 0.88, kathmandu.id, null],
    ['ANM-3105', 'SETTLEMENT_DELAY', 'MEDIUM', 'Settlement delay', 'Settlement queue time exceeded the demo threshold.', 'rule', 0.76, instByCode.SDB.id, null],
  ] as const
  for (const [publicId, type, severity, title, description, method, score, institutionId, merchantId] of anomalySeeds) {
    await prisma.anomaly.create({
      data: { publicId, type, severity, title, description, method, score, institutionId, merchantId, status: 'DETECTED', evidence: { synthetic: true } },
    })
  }

  await prisma.auditLog.createMany({
    data: [
      { userId: admin.id, actorEmail: admin.email, action: 'LOGIN', resource: 'AUTH', resourceId: admin.id, ipAddress: '127.0.0.1', userAgent: 'seed' },
      { userId: admin.id, actorEmail: admin.email, action: 'UPDATED_THRESHOLDS', resource: 'SETTINGS', resourceId: 'thresholds', previousValue: { failureRatePct: 4 }, newValue: { failureRatePct: 5 } },
    ],
  })
  await prisma.notification.createMany({
    data: [
      { userId: admin.id, type: 'INCIDENT', title: 'Historical incident seeded', message: 'Payment API latency is available for review.', severity: 'HIGH', link: '/incidents/INC-2041' },
      { userId: engineer.id, type: 'ANOMALY', title: 'High value spike', message: 'Demo ABC Store exceeded its normal hourly value.', severity: 'HIGH', link: '/anomalies' },
    ],
  })
  const from = new Date(Date.now() - 86400_000)
  await prisma.report.create({
    data: {
      type: 'DAILY_OPERATIONS',
      title: 'Daily Operations Report · seed',
      dateFrom: from,
      dateTo: new Date(),
      createdById: admin.id,
      deliveryStatus: 'EMAIL_DISABLED',
      payload: {
        synthetic: true,
        total: target,
        note: 'Open Reports and generate a fresh report for live aggregates.',
        aiSummary: 'Seed report placeholder. Generate a new report to snapshot current database metrics. AI-generated analysis — verify before taking operational action.',
      },
    },
  })
  for (let i = 0; i < 48; i += 1) {
    await prisma.systemMetric.create({
      data: {
        recordedAt: new Date(Date.now() - i * 3600_000),
        cpu: 22 + (i % 7),
        memory: 40 + (i % 5),
        dbConnections: 12 + (i % 4),
        redisUp: true,
        queueLength: i % 3,
        healthScore: 92,
        simulated: true,
      },
    })
  }
  const conversation = await prisma.aiConversation.create({ data: { userId: admin.id, title: 'Failure rate question' } })
  await prisma.aiMessage.createMany({
    data: [
      { conversationId: conversation.id, role: 'user', content: 'Which institution has the highest failure rate?' },
      { conversationId: conversation.id, role: 'assistant', content: 'Ask again after seed to calculate this from the current database.', tool: 'getInstitutionMetrics' },
    ],
  })
  console.log('Seed complete. Demo passwords are for local development only.')
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
