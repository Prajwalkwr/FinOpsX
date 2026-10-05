import http from 'http'
import jwt from 'jsonwebtoken'
import { Server } from 'socket.io'
import { app } from './app.js'
import { configProblems, env, isAllowedOrigin } from './config/env.js'
import { logger } from './lib/logger.js'
import { setIo } from './lib/realtime.js'
import { connectRedis } from './lib/redis.js'
import { startHealthLoop } from './services/healthService.js'
import { startReportScheduler } from './services/reportService.js'
import { bootSimulator } from './simulator/engine.js'

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
  })
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (typeof token !== 'string') {
      next(new Error('unauthorized'))
      return
    }
    try {
      jwt.verify(token, env.jwtSecret)
      next()
    } catch {
      next(new Error('unauthorized'))
    }
  })
  setIo(io)
  try {
    startHealthLoop()
    startReportScheduler()
    await bootSimulator()
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
