import http from 'http'
import jwt from 'jsonwebtoken'
import { Server } from 'socket.io'
import { ROLES, type Role } from '@finopsx/shared'
import { app } from './app.js'
import { configProblems, env, isAllowedOrigin } from './config/env.js'
import { logger } from './lib/logger.js'
import { prisma } from './lib/prisma.js'
import { roomsForRole, setIo } from './lib/realtime.js'
import { connectRedis } from './lib/redis.js'
import { runDataQualityScan } from './services/dataQualityService.js'
import { startHealthLoop } from './services/healthService.js'
import { startMonitoring } from './services/incidentRules.js'
import { startJobScheduler } from './services/jobService.js'
import { startLiveMetrics } from './services/liveMetrics.js'
import { runReconciliation } from './services/reconciliationService.js'
import { startReportScheduler } from './services/reportService.js'
import { bootSimulator } from './simulator/engine.js'
import { resolveRange } from './utils/range.js'

/** First boot after a fresh seed: populate data quality issues and one reconciliation run so those pages have real results. */
async function bootstrapOperationalData() {
  if ((await prisma.dataQualityIssue.count()) === 0) await runDataQualityScan()
  if ((await prisma.reconciliationRun.count()) === 0) {
    const range = resolveRange({ range: 'yesterday' })
    await runReconciliation({ from: range.from, to: range.to })
  }
}

export async function start() {
  if (configProblems.length && env.isProd) {
    console.error('FinOpsX configuration is incomplete:')
    configProblems.forEach((problem) => console.error(`- ${problem}`))
    process.exit(1)
  }
  await connectRedis()
  const server = http.createServer(app)
  const io = new Server(server, {
    cors: { origin: (origin, callback) => callback(null, !origin || isAllowedOrigin(origin)), credentials: true },
    pingInterval: 20_000,
    pingTimeout: 20_000,
  })
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string') {
      next(new Error('unauthorized'))
      return
    }
    try {
      const payload = jwt.verify(token, env.jwtSecret) as { sub: string; role: Role; type?: string }
      if (payload.type && payload.type !== 'access') throw new Error('wrong token type')
      if (!ROLES.includes(payload.role)) throw new Error('unknown role')
      socket.data.userId = payload.sub
      socket.data.role = payload.role
      next()
    } catch {
      next(new Error('unauthorized'))
    }
  })
  io.on('connection', (socket) => {
    void socket.join([`user:${socket.data.userId}`, ...roomsForRole(socket.data.role as Role)])
    socket.emit('realtime:ready', { at: new Date().toISOString() })
  })
  setIo(io)
  try {
    await bootSimulator()
    startHealthLoop()
    startMonitoring()
    startReportScheduler()
    startJobScheduler()
    startLiveMetrics()
    bootstrapOperationalData().catch((error) => logger.warn('operational bootstrap skipped', { error: error instanceof Error ? error.message : 'unknown' }))
  } catch (error) {
    logger.error('background services did not start', { error: error instanceof Error ? error.message : 'unknown' })
  }
  server.listen(env.port, '0.0.0.0', () => {
    logger.info('FinOpsX API listening', { port: env.port, ai: env.aiEnabled ? 'openai' : 'mock' })
  })
}

const entry = process.argv[1]?.replace(/\\/g, '/')
if (entry?.endsWith('/src/index.ts') || entry?.endsWith('/dist/index.js')) {
  start().catch((error) => {
    logger.error('startup failed', { error: error instanceof Error ? error.message : 'unknown' })
    process.exit(1)
  })
}
