import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { Request } from 'express'
import type { PublicUser, Role } from '@finopsx/shared'
import { AppError, unauthorized } from '../lib/errors.js'
import { prisma } from '../lib/prisma.js'
import { env } from '../config/env.js'
import { writeAudit } from './audit.js'
import { sendEmail } from './email.js'

const DEMO_ACCOUNTS = [
  { role: 'SUPER_ADMIN' as const, name: 'Asha Shrestha', email: 'admin@finopsx.demo', password: 'Admin@12345' },
  { role: 'OPERATIONS_MANAGER' as const, name: 'Rajan Thapa', email: 'operations@finopsx.demo', password: 'Operations@12345' },
  { role: 'ANALYST' as const, name: 'Maya Gurung', email: 'analyst@finopsx.demo', password: 'Analyst@12345' },
  { role: 'ENGINEER' as const, name: 'Nabin KC', email: 'engineer@finopsx.demo', password: 'Engineer@12345' },
  { role: 'AUDITOR' as const, name: 'Sita Poudel', email: 'auditor@finopsx.demo', password: 'Auditor@12345' },
]

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

type UserWithRole = {
  id: string
  email: string
  name: string
  status: 'ACTIVE' | 'LOCKED' | 'DEACTIVATED'
  lastLoginAt: Date | null
  timezone: string
  theme: string
  notifyIncidents: boolean
  notifyAnomalies: boolean
  notifyReports: boolean
  notifySecurity: boolean
  role: { name: Role }
}

export function toPublicUser(user: UserWithRole): PublicUser {
  const theme = user.theme === 'light' || user.theme === 'dark' || user.theme === 'system' ? user.theme : 'system'
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role.name,
    status: user.status,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    timezone: user.timezone,
    theme,
    notifyIncidents: user.notifyIncidents,
    notifyAnomalies: user.notifyAnomalies,
    notifyReports: user.notifyReports,
    notifySecurity: user.notifySecurity,
  }
}

async function issueTokens(user: UserWithRole, rememberMe: boolean, req: Request) {
  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role.name, type: 'access' },
    env.jwtSecret,
    { expiresIn: '15m' },
  )
  const days = rememberMe ? 30 : 7
  const expiresAt = new Date(Date.now() + days * 86400_000)
  const row = await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: 'pending',
      expiresAt,
      userAgent: req.header('user-agent')?.slice(0, 240),
      ipAddress: req.ip,
    },
  })
  const refreshToken = jwt.sign(
    { sub: user.id, jti: row.id, type: 'refresh' },
    env.jwtRefresh,
    { expiresIn: `${days}d` },
  )
  await prisma.refreshToken.update({
    where: { id: row.id },
    data: { tokenHash: sha256(refreshToken) },
  })
  return { accessToken, refreshToken, expiresAt }
}

export async function login(input: { email: string; password: string; rememberMe?: boolean }, req: Request) {
  const user = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase() },
    include: { role: true },
  })
  if (!user) {
    await writeAudit({
      actorEmail: input.email.toLowerCase(),
      action: 'FAILED_LOGIN',
      resource: 'AUTH',
      req,
      newValue: { reason: 'unknown_user' },
    })
    throw unauthorized('Invalid email or password.')
  }
  if (user.status === 'DEACTIVATED') {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been deactivated.')
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Your account has been temporarily locked.')
  }
  const matches = await bcrypt.compare(input.password, user.passwordHash)
  if (!matches) {
    const failed = user.failedLoginCount + 1
    const lock = failed >= 5
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failed,
        status: lock ? 'LOCKED' : user.status,
        lockedUntil: lock ? new Date(Date.now() + 15 * 60_000) : user.lockedUntil,
      },
    })
    await writeAudit({
      user,
      action: 'FAILED_LOGIN',
      resource: 'AUTH',
      resourceId: user.id,
      req,
      newValue: { failed },
    })
    if (lock) throw new AppError(423, 'ACCOUNT_LOCKED', 'Your account has been temporarily locked.')
    throw unauthorized('Invalid email or password.')
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, status: 'ACTIVE', lockedUntil: null, lastLoginAt: new Date() },
    include: { role: true },
  })
  const tokens = await issueTokens(updated, Boolean(input.rememberMe), req)
  await writeAudit({ user: updated, action: 'LOGIN', resource: 'AUTH', resourceId: user.id, req })
  return { ...tokens, user: toPublicUser(updated) }
}

export async function refresh(refreshToken: string, req: Request) {
  let payload: { sub: string; jti: string; type?: string }
  try {
    payload = jwt.verify(refreshToken, env.jwtRefresh) as { sub: string; jti: string; type?: string }
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.')
    }
    throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.')
  }
  if (payload.type !== 'refresh') {
    throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.')
  }
  const row = await prisma.refreshToken.findUnique({ where: { id: payload.jti } })
  if (!row || row.revokedAt || row.tokenHash !== sha256(refreshToken) || row.expiresAt < new Date()) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.')
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { role: true } })
  if (!user || user.status === 'DEACTIVATED') {
    throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.')
  }
  const remember = row.expiresAt.getTime() - row.createdAt.getTime() > 10 * 86400_000
  const tokens = await issueTokens(user, remember, req)
  await prisma.refreshToken.update({
    where: { id: row.id },
    data: { revokedAt: new Date(), replacedBy: 'rotated' },
  })
  return { ...tokens, user: toPublicUser(user) }
}

export async function logout(refreshToken: string | undefined, req: Request) {
  const user = (req as Request & { user?: { id: string; email: string } }).user
  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, env.jwtRefresh) as { jti: string }
      await prisma.refreshToken.updateMany({
        where: { id: payload.jti, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    } catch {
      // Expired refresh tokens can still end the client session.
    }
  }
  if (user) {
    await writeAudit({ user, action: 'LOGOUT', resource: 'AUTH', resourceId: user.id, req })
  }
}

export async function forgotPassword(email: string) {
  const generic = {
    message: 'If an account exists, password reset instructions have been created.',
    email: 'Email delivery is disabled in demo environment.',
    resetToken: undefined as string | undefined,
  }
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
  if (!user || user.status === 'DEACTIVATED') return generic
  const raw = crypto.randomBytes(24).toString('hex')
  await prisma.passwordReset.create({
    data: {
      userId: user.id,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  })
  const mail = await sendEmail(
    user.email,
    'FinOpsX password reset',
    `Use this development reset token: ${raw}\nIt expires in 30 minutes.`,
  )
  return {
    message: generic.message,
    email: mail.message,
    resetToken: env.isProd ? undefined : raw,
  }
}

export async function resetPassword(token: string, password: string, req: Request) {
  const row = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } })
  if (!row || row.usedAt || row.expiresAt < new Date()) {
    throw new AppError(400, 'RESET_INVALID', 'This reset link is invalid or has expired.')
  }
  const passwordHash = await bcrypt.hash(password, 10)
  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash, failedLoginCount: 0, status: 'ACTIVE', lockedUntil: null },
    }),
    prisma.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ])
  await writeAudit({
    user: row.user,
    action: 'PASSWORD_RESET',
    resource: 'USER',
    resourceId: row.userId,
    req,
  })
}

export function demoAccounts() {
  if (!env.showDemoAccounts) return []
  return DEMO_ACCOUNTS.map((account) => ({
    ...account,
    note: 'Demo credential. Do not use in production.',
  }))
}

export { DEMO_ACCOUNTS }
