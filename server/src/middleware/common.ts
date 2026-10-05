import crypto from 'crypto'
import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import type { ZodType } from 'zod'
import { env } from '../config/env.js'
import { AppError, unauthorized } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { logger } from '../lib/logger.js'
import { prisma } from '../lib/prisma.js'
import { incrementWindow } from '../lib/redis.js'

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id')
  const requestId = incoming && /^[\w-]{8,80}$/.test(incoming) ? incoming : crypto.randomUUID()
  ;(req as Request & { requestId: string }).requestId = requestId
  res.setHeader('X-Request-ID', requestId)
  const started = Date.now()
  res.on('finish', () => {
    logger.info('request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
    })
  })
  next()
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req as Request & { requestId?: string }).requestId
  if (err instanceof AppError) {
    res.status(err.status).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details ?? [],
        requestId,
      },
    })
    return
  }
  if (err instanceof jwt.TokenExpiredError) {
    res.status(401).json({
      success: false,
      error: {
        code: 'SESSION_EXPIRED',
        message: 'Your session has expired. Please sign in again.',
        details: [],
        requestId,
      },
    })
    return
  }
  logger.error('unhandled error', {
    requestId,
    error: err instanceof Error ? err.message : 'unknown',
  })
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please retry.',
      details: [],
      requestId,
    },
  })
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      details: [],
      requestId: (req as Request & { requestId?: string }).requestId,
    },
  })
}

export function validate(schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse({
      body: req.body ?? {},
      query: req.query ?? {},
      params: req.params ?? {},
    })
    if (!result.success) {
      next(
        new AppError(400, 'VALIDATION_ERROR', 'Invalid request', result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }))),
      )
      return
    }
    ;(req as Request & { validated: unknown }).validated = result.data
    next()
  }
}

export function rateLimit(options: { windowMs: number; max: number; prefix: string }) {
  const max = env.isProd ? options.max : Math.max(options.max, options.max * 5)
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as Request & { user?: AuthUser }).user
      const key = `${options.prefix}:${user?.id ?? req.ip ?? 'unknown'}`
      const count = await incrementWindow(key, options.windowMs)
      res.setHeader('X-RateLimit-Limit', String(max))
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)))
      if (count > max) {
        next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.'))
        return
      }
      next()
    } catch (error) {
      next(error)
    }
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header('authorization')
    if (!header?.startsWith('Bearer ')) throw unauthorized('Authentication required.')
    const token = header.slice(7)
    const payload = jwt.verify(token, env.jwtSecret) as {
      sub: string
      email: string
      name: string
      role: AuthUser['role']
      type?: string
    }
    if (payload.type && payload.type !== 'access') throw unauthorized('Authentication required.')
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: true },
    })
    if (!user || user.status === 'DEACTIVATED') throw unauthorized('Authentication required.')
    if (user.status === 'LOCKED' && user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Your account has been temporarily locked.')
    }
    ;(req as Request & { user: AuthUser }).user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role.name,
    }
    next()
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.'))
      return
    }
    if (error instanceof AppError) {
      next(error)
      return
    }
    next(unauthorized('Authentication required.'))
  }
}

const idempotencyMemory = new Map<string, { status: number; body: unknown; at: number }>()

export function idempotency(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    next()
    return
  }
  const key = req.header('idempotency-key')
  if (!key || key.length < 8 || key.length > 120) {
    next()
    return
  }
  const cacheKey = `${req.method}:${req.path}:${key}`
  const hit = idempotencyMemory.get(cacheKey)
  if (hit) {
    res.status(hit.status).json(hit.body)
    return
  }
  const original = res.json.bind(res)
  res.json = ((body: unknown) => {
    idempotencyMemory.set(cacheKey, { status: res.statusCode, body, at: Date.now() })
    if (idempotencyMemory.size > 500) {
      const oldest = [...idempotencyMemory.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) idempotencyMemory.delete(oldest[0])
    }
    return original(body)
  }) as Response['json']
  next()
}
