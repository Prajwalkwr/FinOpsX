import type { NextFunction, Request, Response } from 'express'
import type { Permission, Role } from '@finopsx/shared'
import { can } from '@finopsx/shared'
import { forbidden, unauthorized } from './errors.js'

export type AuthUser = {
  id: string
  email: string
  name: string
  role: Role
}

export interface AuthedRequest extends Request {
  user: AuthUser
  requestId: string
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

export function ok(res: Response, data: unknown, status = 200) {
  return res.status(status).json({ success: true, data })
}

export function requireUser(req: Request): AuthUser {
  const user = (req as AuthedRequest).user
  if (!user) throw unauthorized()
  return user
}

export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = requireUser(req)
    if (!can(user.role, permission)) {
      next(forbidden('You do not have access to this area.'))
      return
    }
    next()
  }
}

export function pageOf<T>(items: T[], total: number, page: number, limit: number) {
  return {
    items,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  }
}
