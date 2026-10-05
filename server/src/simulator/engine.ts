import crypto from 'crypto'
import type { FailureReason, PaymentMethod, TxStatus } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { emit, emitTransaction } from '../lib/realtime.js'
import { getRedis } from '../lib/redis.js'
import { evaluateTransaction, scanWindows } from '../services/anomalyService.js'
import { raiseIncident } from '../services/incidentService.js'
import { getThresholds } from '../services/thresholds.js'

type Weights = { id: string; weight: number }

function pick<T extends Weights>(items: T[], rng: () => number) {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  let cursor = rng() * total
  for (const item of items) {
    cursor -= item.weight
    if (cursor <= 0) return item
  }
  return items[items.length - 1]
}

function publicId() {
  return `TXN${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

const METHODS: Array<{ id: PaymentMethod; weight: number }> = [
  { id: 'QR', weight: 40 },
  { id: 'WALLET', weight: 25 },
  { id: 'BANK_TRANSFER', weight: 15 },
  { id: 'CARD', weight: 12 },
  { id: 'MOBILE_BANKING', weight: 8 },
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

let timer: NodeJS.Timeout | null = null
let scanTimer: NodeJS.Timeout | null = null
let configCache: Awaited<ReturnType<typeof loadConfig>> | null = null
let configAt = 0

async function loadConfig() {
  return prisma.simulatorConfig.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default', running: false },
  })
}

async function currentConfig() {
  if (!configCache || Date.now() - configAt > 2000) {
    configCache = await loadConfig()
    configAt = Date.now()
  }
  return configCache
}

export function clearSimulatorCache() {
  configCache = null
}

function scenarioMods(config: Awaited<ReturnType<typeof loadConfig>>) {
  const intensity = config.scenarioIntensity || 1
  switch (config.scenario) {
    case 'BANK_API_LATENCY':
      return { failure: 0.22 * intensity, pending: 0.08, latency: 6.5, reason: 'TIMEOUT' as FailureReason, tpm: config.tpm }
    case 'PAYMENT_FAILURE_SPIKE':
      return { failure: 0.35 * intensity, pending: 0.05, latency: 2.2, reason: 'BANK_API_ERROR' as FailureReason, tpm: config.tpm }
    case 'SETTLEMENT_DELAY':
      return { failure: 0.08, pending: 0.12, latency: 3, reason: 'SETTLEMENT_DELAY' as FailureReason, tpm: config.tpm, settlement: true }
    case 'NOTIFICATION_DEGRADATION':
      return { failure: config.failureRate, pending: config.pendingRate, latency: 1.2, reason: 'SERVICE_UNAVAILABLE' as FailureReason, tpm: config.tpm, notifyFail: true }
    case 'HIGH_VOLUME':
      return { failure: config.failureRate, pending: config.pendingRate, latency: 1.4, tpm: Math.round(config.tpm * (3 + intensity)) }
    case 'MERCHANT_ACTIVITY':
      return { failure: config.failureRate, pending: config.pendingRate, latency: 1, tpm: config.tpm, merchantBoost: true, highValue: 0.18 }
    default:
      return {
        failure: config.failureRate,
        pending: config.pendingRate,
        latency: 1,
        tpm: config.tpm,
        highValue: config.highValueRate,
      }
  }
}

async function generateOne() {
  const config = await currentConfig()
  if (!config.running) return
  const mods = scenarioMods(config)
  const [institutions, merchants, banking] = await Promise.all([
    prisma.institution.findMany(),
    prisma.merchant.findMany(),
    prisma.service.findUnique({ where: { key: 'banking-api' } }),
  ])
  if (!institutions.length || !merchants.length) return
  const rng = Math.random
  const institutionWeights = institutions.map((institution) => ({
    ...institution,
    weight: config.scenario === 'BANK_API_LATENCY' && institution.code === 'HDB' ? 8 : 2,
  }))
  const institution = pick(institutionWeights, rng)
  const merchant = pick(
    merchants.map((item, index) => ({
      ...item,
      weight: mods.merchantBoost && index === 0 ? 12 : 1,
    })),
    rng,
  )
  const method = pick(METHODS, rng)
  const highValueChance = mods.highValue ?? config.highValueRate
  const amount = rng() < highValueChance
    ? Math.round(80000 + rng() * 140000)
    : Math.round(80 + Math.pow(rng(), 2) * 12000)
  let roll = rng()
  let status: TxStatus = 'SUCCESS'
  if (roll < mods.failure) status = 'FAILED'
  else if (roll < mods.failure + mods.pending) status = 'PENDING'
  else if (roll > 0.995) status = 'CANCELLED'
  else if (roll > 0.99) status = 'REFUNDED'
  const baseLatency = institution.code === 'KDB' ? 1800 : institution.code === 'HDB' ? 900 : 480
  const responseTimeMs = Math.round(baseLatency * (mods.latency || 1) * (0.7 + rng() * 0.6) * (status === 'FAILED' ? 1.8 : 1))
  const failureReason = status === 'FAILED' ? mods.reason ?? REASONS[Math.floor(rng() * REASONS.length)] : null
  const suspicious = amount >= 100000 || (status === 'FAILED' && rng() < 0.2)
  const createdAt = new Date()
  const timeline = [
    ['Payment Switch', 'Request received', 'OK'],
    ['Banking API', 'Bank authentication', status === 'FAILED' && failureReason === 'AUTHENTICATION_FAILURE' ? 'FAILED' : 'OK'],
    ['Transaction Processor', 'Payment processing', 'OK'],
    ['Banking API', 'Bank response', status === 'FAILED' ? 'FAILED' : status === 'PENDING' ? 'PENDING' : 'OK'],
    ['Transaction Processor', status === 'SUCCESS' ? 'Transaction completed' : status === 'FAILED' ? 'Transaction failed' : 'Transaction pending', status],
    ['Settlement Service', status === 'SUCCESS' ? 'Settlement queued' : 'Settlement skipped', status === 'SUCCESS' ? 'QUEUED' : 'SKIPPED'],
  ] as const
  const row = await prisma.transaction.create({
    data: {
      transactionId: publicId(),
      customerId: `CUS-******${String(Math.floor(rng() * 900) + 100)}`,
      merchantId: merchant.id,
      institutionId: institution.id,
      amount,
      paymentMethod: method.id,
      status,
      responseTimeMs,
      riskScore: Math.min(99, Math.round((suspicious ? 70 : 10) + rng() * 25 + (status === 'FAILED' ? 15 : 0))),
      failureReason,
      settlementStatus: mods.settlement ? 'DELAYED' : status === 'SUCCESS' ? 'QUEUED' : 'NOT_STARTED',
      notificationStatus: mods.notifyFail ? 'FAILED' : status === 'PENDING' ? 'PENDING' : 'SENT',
      correlationId: `cor_${crypto.randomBytes(6).toString('hex')}`,
      apiEndpoint: 'POST /api/payments',
      suspicious,
      createdAt,
      events: {
        create: timeline.map((item, index) => ({
          service: item[0],
          event: item[1],
          status: item[2],
          createdAt: new Date(createdAt.getTime() + index * 40),
        })),
      },
    },
  })
  const redis = getRedis()
  if (redis) {
    await redis.incr('finopsx:tx:total').catch(() => undefined)
    await redis.incr(`finopsx:tx:${status}`).catch(() => undefined)
  }
  emitTransaction({
    transactionId: row.transactionId,
    status: row.status,
    amount,
    institution: institution.name,
    merchant: merchant.name,
    createdAt: row.createdAt.toISOString(),
  })
  await evaluateTransaction({
    amount,
    status,
    institutionId: institution.id,
    merchantId: merchant.id,
    responseTimeMs,
    createdAt,
  })
  if (banking && responseTimeMs > 5000) {
    await prisma.apiMetric.updateMany({
      where: { endpoint: '/api/payments' },
      data: { latencyMs: responseTimeMs, status: 'DEGRADED', errorRate: status === 'FAILED' ? 8 : 2 },
    })
  }
}

export async function evaluateRules() {
  const thresholds = await getThresholds()
  const since = new Date(Date.now() - 60_000)
  const [total, failed, slow] = await Promise.all([
    prisma.transaction.count({ where: { createdAt: { gte: since } } }),
    prisma.transaction.count({ where: { createdAt: { gte: since }, status: 'FAILED' } }),
    prisma.transaction.aggregate({ where: { createdAt: { gte: since } }, _avg: { responseTimeMs: true } }),
  ])
  const failureRate = total ? (failed / total) * 100 : 0
  if (failureRate > thresholds.failureRatePct && total >= Math.min(thresholds.rpmGate, 15)) {
    const groupedFailures = await prisma.transaction.groupBy({
      by: ['institutionId'],
      where: { createdAt: { gte: since }, status: 'FAILED' },
      _count: { _all: true },
    })
    const worst = groupedFailures.sort((a, b) => b._count._all - a._count._all).slice(0, 1)
    const service = await prisma.service.findUnique({ where: { key: 'payment-switch' } })
    await raiseIncident({
      title: 'Payment failure rate exceeded threshold',
      description: `Failure rate is ${failureRate.toFixed(1)}% across ${total} transactions in the last minute.`,
      severity: failureRate > 20 ? 'CRITICAL' : 'HIGH',
      incidentType: 'FAILURE_SPIKE',
      serviceIds: service ? [service.id] : [],
      institutionIds: worst[0] ? [worst[0].institutionId] : [],
      affectedTransactionCount: failed,
      failureRate,
      latencyMs: slow._avg.responseTimeMs ?? undefined,
    })
  }
}

async function tick() {
  const config = await currentConfig()
  if (!config.running) return
  const mods = scenarioMods(config)
  const perSecond = Math.max(1, Math.round(mods.tpm / 60))
  for (let i = 0; i < Math.min(perSecond, 8); i += 1) {
    await generateOne()
  }
  if (Math.random() < 0.25) await evaluateRules()
}

export async function startSimulator() {
  const config = await prisma.simulatorConfig.update({ where: { id: 'default' }, data: { running: true } })
  clearSimulatorCache()
  ensureLoops()
  return config
}

export async function stopSimulator() {
  const config = await prisma.simulatorConfig.update({ where: { id: 'default' }, data: { running: false, scenario: null } })
  clearSimulatorCache()
  return config
}

export async function resetSimulator() {
  const config = await prisma.simulatorConfig.update({
    where: { id: 'default' },
    data: {
      running: false,
      tpm: 60,
      successRate: 0.94,
      failureRate: 0.04,
      pendingRate: 0.02,
      highValueRate: 0.01,
      anomalyRate: 0.01,
      scenario: null,
      scenarioIntensity: 1,
      scenarioStartedAt: null,
    },
  })
  clearSimulatorCache()
  return config
}

export async function updateSimulator(input: Partial<{ tpm: number; successRate: number; failureRate: number; pendingRate: number; highValueRate: number; anomalyRate: number }>) {
  const config = await prisma.simulatorConfig.update({ where: { id: 'default' }, data: input })
  clearSimulatorCache()
  return config
}

export async function simulatorStatus() {
  const config = await currentConfig()
  return {
    running: config.running,
    tpm: config.tpm,
    successRate: config.successRate,
    failureRate: config.failureRate,
    pendingRate: config.pendingRate,
    highValueRate: config.highValueRate,
    anomalyRate: config.anomalyRate,
    scenario: config.scenario,
    scenarioIntensity: config.scenarioIntensity,
    scenarioStartedAt: config.scenarioStartedAt?.toISOString() ?? null,
    warning: 'This is a demo simulation. It writes synthetic transactions only.',
  }
}

const SCENARIOS: Record<string, { title: string; serviceKey: string; incidentType: string }> = {
  BANK_API_LATENCY: { title: 'Bank API latency spike', serviceKey: 'banking-api', incidentType: 'LATENCY' },
  PAYMENT_FAILURE_SPIKE: { title: 'Payment failure spike', serviceKey: 'payment-switch', incidentType: 'FAILURE_SPIKE' },
  SETTLEMENT_DELAY: { title: 'Settlement delay', serviceKey: 'settlement-service', incidentType: 'SETTLEMENT' },
  NOTIFICATION_DEGRADATION: { title: 'Notification service degradation', serviceKey: 'notification-service', incidentType: 'NOTIFICATION' },
  HIGH_VOLUME: { title: 'High transaction volume', serviceKey: 'transaction-processor', incidentType: 'VOLUME' },
  MERCHANT_ACTIVITY: { title: 'Merchant activity anomaly', serviceKey: 'merchant-api', incidentType: 'MERCHANT' },
}

export async function startScenario(name: string, intensity = 1) {
  const meta = SCENARIOS[name]
  if (!meta) throw new Error('Unknown scenario')
  await prisma.simulatorConfig.update({
    where: { id: 'default' },
    data: { running: true, scenario: name, scenarioIntensity: intensity, scenarioStartedAt: new Date() },
  })
  clearSimulatorCache()
  ensureLoops()
  const service = await prisma.service.findUnique({ where: { key: meta.serviceKey } })
  if (service) {
    await prisma.service.update({
      where: { id: service.id },
      data: { status: name === 'SETTLEMENT_DELAY' ? 'INCIDENT' : 'DEGRADED' },
    })
  }
  for (let i = 0; i < 20; i += 1) await generateOne()
  await scanWindows()
  await evaluateRules()
  emit('system:status', { scenario: name })
  return simulatorStatus()
}

export async function resolveScenario() {
  const config = await currentConfig()
  const name = config.scenario
  await prisma.simulatorConfig.update({
    where: { id: 'default' },
    data: { scenario: null, scenarioStartedAt: null, scenarioIntensity: 1 },
  })
  clearSimulatorCache()
  await prisma.service.updateMany({ data: { status: 'OPERATIONAL' } })
  if (name && SCENARIOS[name]) {
    const open = await prisma.incident.findFirst({
      where: { incidentType: SCENARIOS[name].incidentType, status: { notIn: ['RESOLVED', 'CLOSED'] } },
      orderBy: { createdAt: 'desc' },
    })
    if (open) {
      await prisma.incident.update({
        where: { id: open.id },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolution: 'Scenario ended and simulated service metrics recovered.' },
      })
      await prisma.incidentEvent.createMany({
        data: [
          { incidentId: open.id, message: 'Service recovered.', actorEmail: 'system@finopsx.demo' },
          { incidentId: open.id, message: 'Incident resolved.', actorEmail: 'system@finopsx.demo' },
        ],
      })
      emit('incident:resolved', { id: open.publicId })
    }
  }
  emit('service:recovered', { scenario: name })
  return simulatorStatus()
}

function ensureLoops() {
  if (!timer) timer = setInterval(() => { tick().catch(() => undefined) }, 1000)
  if (!scanTimer) scanTimer = setInterval(() => { scanWindows().catch(() => undefined) }, 20000)
}

export async function bootSimulator() {
  const config = await loadConfig()
  if (config.running) ensureLoops()
}
