import { prisma } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'
import { redisState } from '../lib/redis.js'
import { raiseIncident } from './incidentService.js'
import { getThresholds } from './thresholds.js'

const latencyStreak = new Map<string, number>()

const BASE: Record<string, { latency: number; uptime: number }> = {
  'payment-switch': { latency: 120, uptime: 99.98 },
  'wallet-service': { latency: 180, uptime: 99.95 },
  'banking-api': { latency: 240, uptime: 99.9 },
  'merchant-api': { latency: 210, uptime: 99.93 },
  'notification-service': { latency: 90, uptime: 99.97 },
  'settlement-service': { latency: 340, uptime: 99.9 },
  'transaction-processor': { latency: 150, uptime: 99.96 },
  database: { latency: 12, uptime: 99.99 },
  redis: { latency: 4, uptime: 99.99 },
  'ai-service': { latency: 420, uptime: 99.9 },
}

function jitter(value: number, spread: number) {
  return Math.max(1, Math.round(value + (Math.random() - 0.5) * spread))
}

export async function refreshServiceMetrics() {
  const [services, config] = await Promise.all([
    prisma.service.findMany(),
    prisma.simulatorConfig.findUnique({ where: { id: 'default' } }),
  ])
  const scenario = config?.scenario
  for (const service of services) {
    const base = BASE[service.key] ?? { latency: 200, uptime: 99.9 }
    let status: 'OPERATIONAL' | 'DEGRADED' | 'INCIDENT' | 'MAINTENANCE' = 'OPERATIONAL'
    let latency = jitter(base.latency, base.latency * 0.15)
    let uptime = Math.min(100, base.uptime - Math.random() * 0.05)
    if (scenario === 'BANK_API_LATENCY' && service.key === 'banking-api') {
      status = 'DEGRADED'
      latency = jitter(5800 * (config?.scenarioIntensity ?? 1), 400)
      uptime = 97.4
    } else if (scenario === 'PAYMENT_FAILURE_SPIKE' && service.key === 'payment-switch') {
      status = 'DEGRADED'
      latency = jitter(1600, 200)
      uptime = 98.1
    } else if (scenario === 'SETTLEMENT_DELAY' && service.key === 'settlement-service') {
      status = 'INCIDENT'
      latency = jitter(12100, 600)
      uptime = 94.2
    } else if (scenario === 'NOTIFICATION_DEGRADATION' && service.key === 'notification-service') {
      status = 'DEGRADED'
      latency = jitter(2400, 200)
      uptime = 96.5
    } else if (scenario === 'HIGH_VOLUME' && service.key === 'transaction-processor') {
      status = 'DEGRADED'
      latency = jitter(900, 80)
      uptime = 99.2
    }
    const streak = latency >= (await getThresholds()).latencyMs ? (latencyStreak.get(service.id) ?? 0) + 1 : 0
    latencyStreak.set(service.id, streak)
    await prisma.service.update({
      where: { id: service.id },
      data: { status, responseTimeMs: latency, uptime, lastCheckedAt: new Date(), cpu: jitter(28, 10), memory: jitter(46, 8) },
    })
    if (streak >= (await getThresholds()).consecutiveLatencyChecks) {
      await raiseIncident({
        title: `${service.name} latency is above threshold`,
        description: `${service.name} stayed above the latency threshold for ${streak} checks.`,
        severity: 'HIGH',
        incidentType: 'LATENCY',
        serviceIds: [service.id],
        latencyMs: latency,
      })
    }
    if (uptime < (await getThresholds()).availabilityPct) {
      await raiseIncident({
        title: `${service.name} availability dropped`,
        description: `${service.name} availability is ${uptime.toFixed(2)}%, below the configured threshold.`,
        severity: 'CRITICAL',
        incidentType: 'AVAILABILITY',
        serviceIds: [service.id],
      })
    }
  }
  const latest = await prisma.service.findMany()
  emit('system:status', {
    services: latest.map((service) => ({
      key: service.key,
      name: service.name,
      status: service.status,
      responseTimeMs: service.responseTimeMs,
      uptime: service.uptime,
      lastCheckedAt: service.lastCheckedAt.toISOString(),
    })),
  })
}

export async function recordInfrastructure() {
  const services = await prisma.service.findMany()
  const cpu = services.reduce((sum, service) => sum + service.cpu, 0) / Math.max(1, services.length)
  const memory = services.reduce((sum, service) => sum + service.memory, 0) / Math.max(1, services.length)
  await prisma.systemMetric.create({
    data: {
      cpu,
      memory,
      dbConnections: 12 + Math.round(Math.random() * 8),
      redisUp: redisState() === 'UP',
      queueLength: Math.round(Math.random() * 6),
      healthScore: 0,
      simulated: true,
    },
  })
}

export async function systemHealth() {
  const [services, apis, infra] = await Promise.all([
    prisma.service.findMany({ orderBy: { name: 'asc' } }),
    prisma.apiMetric.findMany({ include: { service: true }, orderBy: { endpoint: 'asc' } }),
    prisma.systemMetric.findFirst({ orderBy: { recordedAt: 'desc' } }),
  ])
  return {
    simulatedInfrastructure: true,
    services: services.map((service) => ({
      id: service.id,
      key: service.key,
      name: service.name,
      status: service.status,
      responseTimeMs: service.responseTimeMs,
      uptime: service.uptime,
      lastCheckedAt: service.lastCheckedAt.toISOString(),
    })),
    apis: apis.map((api) => ({
      endpoint: api.endpoint,
      method: api.method,
      service: api.service.name,
      status: api.status,
      latencyMs: api.latencyMs,
      rpm: api.rpm,
      errorRate: api.errorRate,
      p95Ms: api.p95Ms,
      p99Ms: api.p99Ms,
      availability: api.availability,
    })),
    infrastructure: {
      label: 'Simulated infrastructure metrics',
      cpu: infra?.cpu ?? 24,
      memory: infra?.memory ?? 41,
      dbConnections: infra?.dbConnections ?? 14,
      redis: redisState(),
      queueLength: infra?.queueLength ?? 1,
      recordedAt: infra?.recordedAt.toISOString() ?? new Date().toISOString(),
    },
  }
}

let timer: NodeJS.Timeout | null = null
let infraTimer: NodeJS.Timeout | null = null

export function startHealthLoop() {
  if (timer) return
  timer = setInterval(() => {
    refreshServiceMetrics().catch(() => undefined)
  }, 10000)
  infraTimer = setInterval(() => {
    recordInfrastructure().catch(() => undefined)
  }, 60000)
  refreshServiceMetrics().catch(() => undefined)
}

export function stopHealthLoop() {
  if (timer) clearInterval(timer)
  if (infraTimer) clearInterval(infraTimer)
  timer = null
  infraTimer = null
}
