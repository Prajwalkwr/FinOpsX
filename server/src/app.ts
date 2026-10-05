import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { env, isAllowedOrigin } from './config/env.js'
import { prisma } from './lib/prisma.js'
import { redisState } from './lib/redis.js'
import { errorHandler, notFoundHandler, requestContext } from './middleware/common.js'
import { api } from './routes/api.js'
import { simulatorStatus } from './simulator/engine.js'

export const app = express()
app.set('trust proxy', 1)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/docs')) return helmet({ contentSecurityPolicy: false })(req, res, next)
  return helmet()(req, res, next)
})
app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true)
      return
    }
    if (isAllowedOrigin(origin)) {
      callback(null, true)
      return
    }
    callback(new Error('Origin is not allowed.'))
  },
  credentials: true,
}))
app.use(express.json({ limit: '1mb' }))
app.use(requestContext)

async function healthPayload() {
  let database: 'UP' | 'DOWN' = 'DOWN'
  try {
    await prisma.$queryRaw`SELECT 1`
    database = 'UP'
  } catch {
    database = 'DOWN'
  }
  const simulator = await simulatorStatus().catch(() => ({ running: false }))
  return {
    database,
    redis: redisState(),
    ai: env.aiEnabled ? 'AVAILABLE' : 'MOCK',
    simulator: simulator.running ? 'RUNNING' : 'STOPPED',
    email: env.emailEnabled ? 'CONFIGURED' : 'DISABLED',
    synthetic: true,
  }
}

app.get('/health', async (req, res, next) => {
  try {
    const data = await healthPayload()
    res.status(data.database === 'UP' ? 200 : 503).json({ success: data.database === 'UP', data })
  } catch (error) {
    next(error)
  }
})

app.get('/ready', async (req, res, next) => {
  try {
    const data = await healthPayload()
    res.status(data.database === 'UP' ? 200 : 503).json({ success: data.database === 'UP', data })
  } catch (error) {
    next(error)
  }
})

app.use('/api', api)
app.use(notFoundHandler)
app.use(errorHandler)
