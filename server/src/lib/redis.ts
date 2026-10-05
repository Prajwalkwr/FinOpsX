import { createRequire } from 'module'
import { env } from '../config/env.js'
import { logger } from './logger.js'

const require = createRequire(import.meta.url)
const Redis = require('ioredis') as new (
  url: string,
  options?: Record<string, unknown>,
) => {
  connect: () => Promise<void>
  ping: () => Promise<string>
  disconnect: () => void
  on: (event: string, listener: () => void) => void
  incr: (key: string) => Promise<number>
  pexpire: (key: string, ms: number) => Promise<number>
}

type RedisClient = InstanceType<typeof Redis>

let client: RedisClient | null = null
let status: 'UP' | 'DOWN' | 'DISABLED' = env.redisUrl ? 'DOWN' : 'DISABLED'

export function redisState() {
  return status
}

export function getRedis() {
  return status === 'UP' ? client : null
}

export async function connectRedis() {
  if (!env.redisUrl) {
    status = 'DISABLED'
    logger.warn('Redis is not configured. Counters and rate limits use an in-memory fallback.')
    return
  }
  const redis = new Redis(env.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  })
  redis.on('error', () => {
    status = 'DOWN'
  })
  try {
    await redis.connect()
    await redis.ping()
    client = redis
    status = 'UP'
    logger.info('Redis connected')
  } catch (error) {
    status = 'DOWN'
    logger.warn('Redis is unavailable. Continuing with in-memory fallback.', {
      error: error instanceof Error ? error.message : 'unknown',
    })
    redis.disconnect()
  }
}

const memory = new Map<string, { count: number; reset: number }>()

export async function incrementWindow(key: string, windowMs: number): Promise<number> {
  const redis = getRedis()
  if (redis) {
    const count = await redis.incr(key)
    if (count === 1) await redis.pexpire(key, windowMs)
    return count
  }
  const now = Date.now()
  const current = memory.get(key)
  if (!current || current.reset < now) {
    memory.set(key, { count: 1, reset: now + windowMs })
    return 1
  }
  current.count += 1
  return current.count
}
