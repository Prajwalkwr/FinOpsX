import crypto from 'crypto'
import type { FailureReason, PaymentMethod, Prisma, TxStatus } from '@prisma/client'
import { SCENARIO_LABEL, type Scenario } from '@finopsx/shared'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { prisma } from '../lib/prisma.js'
import { emit, emitTransaction } from '../lib/realtime.js'
import { getRedis } from '../lib/redis.js'
import { evaluateTransaction } from '../services/anomalyService.js'
import { markRecovery } from '../services/incidentRules.js'

type Weights = { weight: number }

function pick<T extends Weights>(items: T[], rng: () => number) {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  let cursor = rng() * total
  for (const item of items) {
    cursor -= item.weight
    if (cursor <= 0) return item
  }
  return items[items.length - 1]
}

const METHODS: Array<{ id: PaymentMethod; weight: number }> = [
  { id: 'QR', weight: 40 },
  { id: 'WALLET', weight: 25 },
  { id: 'BANK_TRANSFER', weight: 15 },
  { id: 'CARD', weight: 12 },
  { id: 'ACCOUNT_PAYMENT', weight: 8 },
]

const BASE_LATENCY: Record<string, number> = { DBA: 520, DBB: 1800, DBC: 700, DWL: 300, DPN: 420, DMN: 600 }
const BASE_FAILURE: Record<string, number> = { DBA: 0.8, DBB: 1.25, DBC: 0.9, DWL: 0.5, DPN: 0.7, DMN: 0.8 }
const VOLUME_WEIGHT: Record<string, number> = { DBA: 22, DBB: 20, DBC: 18, DWL: 18, DPN: 12, DMN: 10 }
const TIMEOUT_MS = 8000

const ORDINARY_REASONS: FailureReason[] = ['INSUFFICIENT_FUNDS', 'NETWORK_ERROR', 'INVALID_REQUEST', 'DUPLICATE_TRANSACTION', 'AUTHENTICATION_FAILURE', 'BANK_API_ERROR', 'TIMEOUT']

export const RESPONSE_CODE: Record<string, string> = {
  SUCCESS: '00', PENDING: '09', TIMEOUT: '68', BANK_API_ERROR: '91', INSUFFICIENT_FUNDS: '51', NETWORK_ERROR: '96',
  INVALID_REQUEST: '30', SERVICE_UNAVAILABLE: '91', DUPLICATE_TRANSACTION: '94', AUTHENTICATION_FAILURE: '55', SETTLEMENT_DELAY: '09',
}

export function httpStatusFor(status: TxStatus, reason: FailureReason | null) {
  if (status === 'PENDING') return 202
  if (status !== 'FAILED') return 201
  switch (reason) {
    case 'TIMEOUT': return 504
    case 'BANK_API_ERROR': return 502
    case 'INSUFFICIENT_FUNDS': return 402
    case 'INVALID_REQUEST': return 400
    case 'DUPLICATE_TRANSACTION': return 409
    case 'AUTHENTICATION_FAILURE': return 401
    default: return 503
  }
}

export const SCENARIOS: Record<Scenario, { title: string; serviceKey: string; incidentType: string; institutionCode?: string }> = {
  BANK_API_LATENCY: { title: 'Bank API latency spike', serviceKey: 'bank-api', incidentType: 'LATENCY', institutionCode: 'DBB' },
  PAYMENT_FAILURE_SPIKE: { title: 'Payment failure spike', serviceKey: 'payment-api', incidentType: 'FAILURE_SPIKE' },
  SETTLEMENT_DELAY: { title: 'Settlement delay', serviceKey: 'settlement-service', incidentType: 'SETTLEMENT' },
  NOTIFICATION_DEGRADATION: { title: 'Notification service degradation', serviceKey: 'notification-service', incidentType: 'NOTIFICATION' },
  HIGH_VOLUME: { title: 'High transaction volume', serviceKey: 'payment-gateway', incidentType: 'VOLUME' },
  MERCHANT_ACTIVITY: { title: 'Merchant activity spike', serviceKey: 'merchant-api', incidentType: 'MERCHANT' },
}

let timer: NodeJS.Timeout | null = null
let lifecycleTimer: NodeJS.Timeout | null = null
let ticking = false
let configCache: Awaited<ReturnType<typeof loadConfig>> | null = null
let configAt = 0
let refs: { institutions: Array<{ id: string; code: string; name: string }>; merchants: Array<{ id: string; code: string; name: string }>; endpoints: Record<string, string>; at: number } | null = null
let lastCorrelation = ''

async function loadConfig() {
  return prisma.simulatorConfig.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default', running: false } })
}

export async function currentConfig() {
  if (!configCache || Date.now() - configAt > 2000) {
    configCache = await loadConfig()
    configAt = Date.now()
  }
  return configCache
}

export function clearSimulatorCache() {
  configCache = null
}

async function references() {
  if (!refs || Date.now() - refs.at > 60_000) {
    const [institutions, merchants, endpoints] = await Promise.all([
      prisma.institution.findMany({ select: { id: true, code: true, name: true } }),
      prisma.merchant.findMany({ select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
      prisma.apiEndpoint.findMany({ select: { id: true, method: true, endpoint: true } }),
    ])
    refs = { institutions, merchants, endpoints: Object.fromEntries(endpoints.map((row) => [`${row.method} ${row.endpoint}`, row.id])), at: Date.now() }
  }
  return refs
}

export type ScenarioEffects = {
  tpm: number
  failureRate: number
  pendingRate: number
  highValueRate: number
  latencyFor: (code: string) => number
  failureBoost: (code: string) => { extra: number; reason: FailureReason } | null
  merchantBoost: boolean
  notificationFails: boolean
  settlementDelayed: boolean
}

export function scenarioEffects(config: { scenario: string | null; scenarioIntensity: number; tpm: number; failureRate: number; pendingRate: number; highValueRate: number }): ScenarioEffects {
  const intensity = config.scenarioIntensity || 1
  const base: ScenarioEffects = {
    tpm: config.tpm,
    failureRate: config.failureRate,
    pendingRate: config.pendingRate,
    highValueRate: config.highValueRate,
    latencyFor: () => 1,
    failureBoost: () => null,
    merchantBoost: false,
    notificationFails: false,
    settlementDelayed: false,
  }
  switch (config.scenario) {
    case 'BANK_API_LATENCY':
      return {
        ...base,
        latencyFor: (code) => (code === 'DBB' ? 4.1 * intensity : ['DBA', 'DBC'].includes(code) ? 1.15 : 1),
        failureBoost: (code) => (code === 'DBB' ? { extra: 0.25 * intensity, reason: 'TIMEOUT' } : null),
      }
    case 'PAYMENT_FAILURE_SPIKE':
      return { ...base, latencyFor: () => 1.6, failureBoost: () => ({ extra: 0.3 * intensity, reason: 'BANK_API_ERROR' }) }
    case 'SETTLEMENT_DELAY':
      return { ...base, pendingRate: Math.min(0.3, config.pendingRate + 0.08), settlementDelayed: true }
    case 'NOTIFICATION_DEGRADATION':
      return { ...base, notificationFails: true }
    case 'HIGH_VOLUME':
      return { ...base, tpm: Math.round(config.tpm * (3 + intensity)), latencyFor: () => 1.3 }
    case 'MERCHANT_ACTIVITY':
      return { ...base, merchantBoost: true, highValueRate: 0.18 }
    default:
      return base
  }
}

export function generateCandidate(input: {
  effects: ScenarioEffects
  averageAmount: number
  institutions: Array<{ id: string; code: string; name: string }>
  merchants: Array<{ id: string; code: string; name: string }>
  rng?: () => number
}) {
  const rng = input.rng ?? Math.random
  const { effects } = input
  const institution = pick(input.institutions.map((item) => ({ ...item, weight: VOLUME_WEIGHT[item.code] ?? 10 })), rng)
  const merchant = pick(input.merchants.map((item, index) => ({ ...item, weight: effects.merchantBoost && index === 0 ? 14 : 1 })), rng)
  const method = pick(METHODS, rng).id
  const highValue = rng() < effects.highValueRate
  const amount = highValue
    ? Math.round(80000 + rng() * 140000)
    : Math.max(50, Math.round(input.averageAmount * (0.15 + Math.pow(rng(), 1.6) * 2.6)))
  const latencyMultiplier = effects.latencyFor(institution.code)
  const baseLatency = (BASE_LATENCY[institution.code] ?? 500) * latencyMultiplier
  let responseTimeMs = Math.round(baseLatency * (0.7 + rng() * 0.6))
  const boost = effects.failureBoost(institution.code)
  const failureChance = Math.min(0.95, effects.failureRate * (BASE_FAILURE[institution.code] ?? 1) + (boost?.extra ?? 0))
  const roll = rng()
  let status: TxStatus = 'SUCCESS'
  let failureReason: FailureReason | null = null
  if (responseTimeMs > TIMEOUT_MS) {
    status = 'FAILED'
    failureReason = 'TIMEOUT'
    responseTimeMs = TIMEOUT_MS + Math.round(rng() * 400)
  } else if (roll < failureChance) {
    status = 'FAILED'
    failureReason = boost && rng() < 0.85 ? boost.reason : ORDINARY_REASONS[Math.floor(rng() * ORDINARY_REASONS.length)]
    responseTimeMs = failureReason === 'TIMEOUT' ? TIMEOUT_MS + Math.round(rng() * 400) : Math.round(responseTimeMs * 1.1)
  } else if (roll < failureChance + effects.pendingRate) {
    status = 'PENDING'
  } else if (roll > 0.996) {
    status = 'REVERSED'
  }
  const others = input.institutions.filter((item) => ['DBA', 'DBB', 'DBC'].includes(item.code) && item.id !== institution.id)
  const destinationCode = method === 'BANK_TRANSFER' ? others[Math.floor(rng() * others.length)]?.code : method === 'WALLET' ? 'DWL' : 'DMN'
  const destination = input.institutions.find((item) => item.code === destinationCode) ?? null
  return { institution, merchant, method, amount, status, failureReason, responseTimeMs, destination, highValue }
}

async function generateBatch(count: number) {
  const config = await currentConfig()
  if (!config.running) return
  const effects = scenarioEffects(config)
  const { institutions, merchants, endpoints } = await references()
  if (!institutions.length || !merchants.length) return
  const ledger: Prisma.InstitutionLedgerEntryCreateManyInput[] = []
  const calls: Prisma.ApiCallCreateManyInput[] = []
  for (let i = 0; i < count; i += 1) {
    const candidate = generateCandidate({ effects, averageAmount: config.averageAmount, institutions, merchants })
    const createdAt = new Date()
    const at = (ms: number) => new Date(createdAt.getTime() + ms)
    const { status, failureReason, responseTimeMs, amount } = candidate
    const transactionId = `TXN${crypto.randomBytes(4).toString('hex').toUpperCase()}`
    const correlationId = Math.random() < 0.002 && lastCorrelation ? lastCorrelation : `cor_${crypto.randomBytes(6).toString('hex')}`
    lastCorrelation = correlationId
    const outcome = status === 'FAILED' ? 'FAILED' : status === 'PENDING' ? 'PENDING' : 'SUCCESS'
    const responseCode = Math.random() < 0.002 ? null : status === 'FAILED' ? RESPONSE_CODE[failureReason ?? 'BANK_API_ERROR'] : status === 'PENDING' ? '09' : '00'
    const notificationFailed = effects.notificationFails ? Math.random() < 0.6 : Math.random() < 0.01
    const events: Array<[string, string, string, number]> = [
      ['Payment Gateway', 'INITIATED', 'OK', 0],
      ['Authentication', 'AUTHENTICATING', failureReason === 'AUTHENTICATION_FAILURE' ? 'FAILED' : 'OK', 35],
      ['Payment API', 'PROCESSING', 'OK', 80],
      [candidate.method === 'WALLET' ? 'Wallet Service' : 'Bank API', outcome, outcome, responseTimeMs],
    ]
    if (status === 'SUCCESS') events.push(['Settlement', 'SETTLEMENT', 'QUEUED', responseTimeMs + 40])
    if (status === 'FAILED' || status === 'REVERSED') events.push(['Payment API', 'COMPLETED', status, responseTimeMs + 30])
    if (status === 'REVERSED') events.push(['Payment API', 'REVERSED', 'REVERSED', responseTimeMs + 60])
    const row = await prisma.transaction.create({
      data: {
        transactionId,
        customerId: Math.random() < 0.002 ? 'CUS-UNKNOWN' : `CUS-******${String(Math.floor(Math.random() * 900) + 100)}`,
        merchantId: candidate.merchant.id,
        merchantReference: Math.random() < 0.003 ? null : `ORD-${candidate.merchant.code}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
        institutionId: candidate.institution.id,
        destinationInstitutionId: candidate.destination?.id,
        amount,
        paymentMethod: candidate.method,
        serviceKey: 'payment-api',
        status,
        lifecycleStage: status === 'PENDING' ? 'OUTCOME' : status === 'SUCCESS' ? 'SETTLEMENT' : 'COMPLETED',
        responseCode,
        responseTimeMs,
        riskScore: Math.min(99, Math.round((candidate.highValue ? 70 : 10) + Math.random() * 25 + (status === 'FAILED' ? 15 : 0))),
        failureReason,
        settlementStatus: status === 'SUCCESS' ? 'QUEUED' : 'NOT_STARTED',
        notificationStatus: notificationFailed ? 'FAILED' : status === 'PENDING' ? 'PENDING' : 'SENT',
        correlationId,
        apiEndpoint: 'POST /payments',
        suspicious: amount >= 100000,
        initiatedAt: createdAt,
        authenticatedAt: at(35),
        processedAt: at(responseTimeMs),
        completedAt: status === 'PENDING' ? null : at(responseTimeMs + 30),
        createdAt,
        events: { create: events.map(([service, event, eventStatus, offset]) => ({ service, event, status: eventStatus, createdAt: at(offset) })) },
      },
    })
    if (status === 'SUCCESS' || status === 'REVERSED') {
      const roll = Math.random()
      if (roll >= 0.0015) {
        ledger.push({
          institutionId: candidate.institution.id,
          transactionRef: transactionId,
          transactionId: row.id,
          amount: roll < 0.0025 ? Math.max(1, amount - 500) : amount,
          status,
          recordedAt: at(responseTimeMs + 500),
        })
      }
    }
    const base = { institutionId: candidate.institution.id, transactionRef: transactionId }
    const call = (key: string, statusCode: number, latencyMs: number, offset = 0) => {
      const endpointId = endpoints[key]
      if (endpointId) calls.push({ endpointId, statusCode, latencyMs, createdAt: at(offset), ...base })
    }
    call('POST /auth/token', failureReason === 'AUTHENTICATION_FAILURE' ? 401 : 200, Math.round(30 + Math.random() * 40))
    if (candidate.method === 'QR') call('POST /qr/validate', 200, Math.round(60 + Math.random() * 60), 40)
    if (candidate.method !== 'WALLET') {
      call('POST /bank/authorize', failureReason === 'TIMEOUT' ? 504 : failureReason === 'BANK_API_ERROR' ? 502 : 200, Math.round(responseTimeMs * 0.8), 90)
    }
    call('POST /payments', httpStatusFor(status, failureReason), responseTimeMs)
    if (Math.random() < 0.3) call('GET /payments/:id', 200, Math.round(40 + Math.random() * 60), responseTimeMs + 500)
    call('POST /notify', notificationFailed ? 503 : 200, Math.round((effects.notificationFails ? 2400 : 90) * (0.7 + Math.random() * 0.6)), responseTimeMs + 80)
    if (status === 'REVERSED') call('POST /refund', 200, Math.round(200 + Math.random() * 200), responseTimeMs + 60)
    const redis = getRedis()
    if (redis) {
      await redis.incr('finopsx:tx:total').catch(() => undefined)
      await redis.incr(`finopsx:tx:${status}`).catch(() => undefined)
    }
    emitTransaction({
      transactionId,
      status,
      amount,
      institution: candidate.institution.name,
      merchant: candidate.merchant.name,
      createdAt: createdAt.toISOString(),
    })
    await evaluateTransaction({ amount, status, institutionId: candidate.institution.id, merchantId: candidate.merchant.id, responseTimeMs, createdAt, transactionId })
  }
  if (ledger.length) await prisma.institutionLedgerEntry.createMany({ data: ledger })
  if (calls.length) await prisma.apiCall.createMany({ data: calls })
}

let lastStaleSweep = 0

/** A payment with no final status after 15 minutes is timed out, as a switch would; this also clears seeded history. */
async function expireStalePending() {
  if (Date.now() - lastStaleSweep < 10 * 60_000) return 0
  lastStaleSweep = Date.now()
  return prisma.$executeRaw`
    UPDATE "Transaction"
    SET status = 'FAILED', "failureReason" = 'TIMEOUT', "responseCode" = ${RESPONSE_CODE.TIMEOUT}, "lifecycleStage" = 'COMPLETED',
        "settlementStatus" = 'NOT_STARTED', "notificationStatus" = 'SENT', "completedAt" = "createdAt" + interval '15 minutes', "updatedAt" = now()
    WHERE status = 'PENDING' AND "createdAt" < now() - interval '15 minutes'`
}

/** Pending payments resolve after a delay, which is a real state change that updates timestamps and the ledger. */
export async function resolvePendingTransactions() {
  const expired = await expireStalePending()
  if (expired) logger.info('expired stale pending transactions', { expired })
  const config = await currentConfig()
  const effects = scenarioEffects(config)
  const olderThan = new Date(Date.now() - (effects.settlementDelayed ? 90_000 : 20_000))
  const pending = await prisma.transaction.findMany({
    where: { status: 'PENDING', createdAt: { lte: olderThan, gte: new Date(Date.now() - 24 * 3600_000) } },
    take: 50,
    orderBy: { createdAt: 'asc' },
  })
  for (const tx of pending) {
    const success = Math.random() < 0.8
    const now = new Date()
    await prisma.transaction.update({
      where: { id: tx.id },
      data: {
        status: success ? 'SUCCESS' : 'FAILED',
        failureReason: success ? null : 'TIMEOUT',
        responseCode: success ? '00' : RESPONSE_CODE.TIMEOUT,
        lifecycleStage: success ? 'SETTLEMENT' : 'COMPLETED',
        settlementStatus: success ? 'QUEUED' : 'NOT_STARTED',
        notificationStatus: 'SENT',
        completedAt: now,
        events: {
          create: [
            { service: 'Bank API', event: success ? 'SUCCESS' : 'FAILED', status: success ? 'SUCCESS' : 'FAILED', createdAt: now },
            success
              ? { service: 'Settlement', event: 'SETTLEMENT', status: 'QUEUED', createdAt: new Date(now.getTime() + 40) }
              : { service: 'Payment API', event: 'COMPLETED', status: 'FAILED', createdAt: new Date(now.getTime() + 30) },
          ],
        },
      },
    })
    if (success) {
      await prisma.institutionLedgerEntry.upsert({
        where: { transactionId: tx.id },
        update: { status: 'SUCCESS', amount: tx.amount },
        create: { institutionId: tx.institutionId, transactionRef: tx.transactionId, transactionId: tx.id, amount: tx.amount, status: 'SUCCESS', recordedAt: now },
      })
    }
    emit('transaction:updated', { transactionId: tx.transactionId, status: success ? 'SUCCESS' : 'FAILED' })
  }
  return pending.length
}

async function tick() {
  if (ticking) return
  ticking = true
  try {
    const config = await currentConfig()
    if (!config.running) return
    const effects = scenarioEffects(config)
    const perSecond = effects.tpm / 60
    const whole = Math.floor(perSecond)
    const count = Math.min(12, whole + (Math.random() < perSecond - whole ? 1 : 0))
    if (count > 0) await generateBatch(count)
  } catch (error) {
    logger.error('simulator tick failed', { error: error instanceof Error ? error.message : 'unknown' })
  } finally {
    ticking = false
  }
}

async function lifecycleTick() {
  try {
    await resolvePendingTransactions()
    const config = await currentConfig()
    if (config.running) {
      const { runSettlementCycle } = await import('../services/settlementService.js')
      await runSettlementCycle({ source: 'auto', minAgeMs: 60_000 })
    }
  } catch (error) {
    logger.error('lifecycle tick failed', { error: error instanceof Error ? error.message : 'unknown' })
  }
}

export async function startSimulator() {
  const config = await prisma.simulatorConfig.update({ where: { id: 'default' }, data: { running: true } })
  clearSimulatorCache()
  ensureLoops()
  emit('simulator:status', { running: true })
  return config
}

export async function stopSimulator() {
  const config = await prisma.simulatorConfig.update({ where: { id: 'default' }, data: { running: false } })
  clearSimulatorCache()
  emit('simulator:status', { running: false })
  return config
}

export async function resetSimulator() {
  const config = await prisma.simulatorConfig.update({
    where: { id: 'default' },
    data: { running: false, tpm: 60, successRate: 0.94, failureRate: 0.04, pendingRate: 0.02, highValueRate: 0.01, anomalyRate: 0.01, averageAmount: 3500, scenario: null, scenarioIntensity: 1, scenarioStartedAt: null },
  })
  clearSimulatorCache()
  emit('simulator:status', { running: false })
  return config
}

export async function updateSimulator(input: Partial<{ tpm: number; successRate: number; failureRate: number; pendingRate: number; highValueRate: number; anomalyRate: number; averageAmount: number }>) {
  const config = await prisma.simulatorConfig.update({ where: { id: 'default' }, data: input })
  clearSimulatorCache()
  emit('simulator:status', { running: config.running })
  return config
}

export async function simulatorStatus() {
  const config = await currentConfig()
  const since = new Date(Date.now() - 60_000)
  const lastMinute = await prisma.transaction.count({ where: { createdAt: { gte: since } } })
  return {
    running: config.running,
    tpm: config.tpm,
    successRate: config.successRate,
    failureRate: config.failureRate,
    pendingRate: config.pendingRate,
    highValueRate: config.highValueRate,
    anomalyRate: config.anomalyRate,
    averageAmount: config.averageAmount,
    scenario: config.scenario,
    scenarioLabel: config.scenario ? SCENARIO_LABEL[config.scenario as Scenario] ?? config.scenario : null,
    scenarioIntensity: config.scenarioIntensity,
    scenarioStartedAt: config.scenarioStartedAt?.toISOString() ?? null,
    generatedLastMinute: lastMinute,
    warning: 'This is a demo simulation. It writes synthetic transactions only.',
  }
}

export async function startScenario(name: Scenario, intensity = 1) {
  const meta = SCENARIOS[name]
  await prisma.simulatorConfig.update({
    where: { id: 'default' },
    data: { running: true, scenario: name, scenarioIntensity: intensity, scenarioStartedAt: new Date() },
  })
  clearSimulatorCache()
  ensureLoops()
  await generateBatch(25)
  emit('simulator:status', { running: true, scenario: name, service: meta.serviceKey })
  return simulatorStatus()
}

/** Ends the active scenario and lets simulated metrics recover. Optionally resolves the linked incident. */
export async function resolveScenario(options: { resolveIncidents?: boolean; actorEmail?: string } = {}) {
  const config = await currentConfig()
  const name = config.scenario
  await prisma.simulatorConfig.update({ where: { id: 'default' }, data: { scenario: null, scenarioStartedAt: null, scenarioIntensity: 1 } })
  clearSimulatorCache()
  if (name) markRecovery()
  if (name && options.resolveIncidents !== false) {
    const open = await prisma.incident.findMany({ where: { scenario: name, status: { in: ['DETECTED', 'ACKNOWLEDGED', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATING'] } } })
    for (const incident of open) {
      await prisma.incident.update({
        where: { id: incident.id },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolution: incident.resolution ?? 'Scenario ended and simulated service metrics recovered.' },
      })
      await prisma.incidentEvent.create({ data: { incidentId: incident.id, kind: 'STATUS', message: `Status changed from ${incident.status} to RESOLVED. Simulated metrics recovered after the scenario ended.`, actorEmail: options.actorEmail ?? 'system@finopsx.demo' } })
      emit('incident:resolved', { id: incident.publicId })
    }
    if (open.length) {
      const { count } = await prisma.anomaly.updateMany({
        where: { incidentId: { in: open.map((incident) => incident.id) }, status: { in: ['DETECTED', 'REVIEW'] } },
        data: { status: 'RESOLVED', resolvedAt: new Date(), decisionNote: 'Linked incident resolved after the demo scenario ended.' },
      })
      if (count) emit('anomaly:updated', { resolved: count })
    }
  }
  emit('simulator:status', { running: config.running, scenario: null, endedScenario: name })
  return simulatorStatus()
}

export function ensureLoops() {
  if (!timer) timer = setInterval(() => { void tick() }, 1000)
  if (!lifecycleTimer) lifecycleTimer = setInterval(() => { void lifecycleTick() }, 5000)
}

export function stopLoops() {
  if (timer) clearInterval(timer)
  if (lifecycleTimer) clearInterval(lifecycleTimer)
  timer = null
  lifecycleTimer = null
}

export async function bootSimulator() {
  const config = await loadConfig()
  if (env.simulatorAutostart && !config.running) {
    await prisma.simulatorConfig.update({ where: { id: 'default' }, data: { running: true } })
    clearSimulatorCache()
  }
  ensureLoops()
}

export { generateBatch }
