import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import type { RoleName, UserStatus } from '@prisma/client'
import type { Request } from 'express'
import type { Role } from '@finopsx/shared'
import { conflict, notFound } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { pageOf } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { writeAudit } from './audit.js'
import { toPublicUser } from './authService.js'

async function assertLastSuperAdmin(userId: string, nextRole: Role, nextStatus: UserStatus) {
  const current = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } })
  if (!current || current.role.name !== 'SUPER_ADMIN' || current.status !== 'ACTIVE') return
  const remaining = await prisma.user.count({
    where: { role: { name: 'SUPER_ADMIN' }, status: 'ACTIVE', id: { not: userId } },
  })
  if (remaining === 0 && (nextRole !== 'SUPER_ADMIN' || nextStatus !== 'ACTIVE')) {
    throw conflict('The final active Super Admin cannot be removed or demoted.')
  }
}

export async function listUsers(page: number, limit: number, q?: string) {
  const where = q
    ? { OR: [{ email: { contains: q, mode: 'insensitive' as const } }, { name: { contains: q, mode: 'insensitive' as const } }] }
    : {}
  const skip = (page - 1) * limit
  const [total, rows] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take: limit, include: { role: true } }),
  ])
  return pageOf(rows.map(toPublicUser), total, page, limit)
}

export async function createUser(input: { name: string; email: string; role: Role; password?: string }, actor: AuthUser, req: Request) {
  const password = input.password ?? `Temp@${crypto.randomBytes(4).toString('hex')}9A`
  const role = await prisma.role.findUnique({ where: { name: input.role as RoleName } })
  if (!role) throw notFound('Role not found.')
  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash: await bcrypt.hash(password, 10),
      roleId: role.id,
    },
    include: { role: true },
  })
  await writeAudit({
    user: actor,
    action: 'CREATED_USER',
    resource: 'USER',
    resourceId: user.id,
    req,
    newValue: { email: user.email, role: input.role },
  })
  return { user: toPublicUser(user), temporaryPassword: input.password ? undefined : password }
}

export async function updateUser(id: string, input: { name?: string; role?: Role; status?: UserStatus }, actor: AuthUser, req: Request) {
  const existing = await prisma.user.findUnique({ where: { id }, include: { role: true } })
  if (!existing) throw notFound('User not found.')
  const nextRole = input.role ?? existing.role.name
  const nextStatus = input.status ?? existing.status
  await assertLastSuperAdmin(id, nextRole, nextStatus)
  const role = await prisma.role.findUnique({ where: { name: nextRole } })
  if (!role) throw notFound('Role not found.')
  const user = await prisma.user.update({
    where: { id },
    data: { name: input.name ?? existing.name, roleId: role.id, status: nextStatus },
    include: { role: true },
  })
  await writeAudit({
    user: actor,
    action: input.role && input.role !== existing.role.name ? 'CHANGED_ROLE' : 'UPDATED_USER',
    resource: 'USER',
    resourceId: id,
    req,
    previousValue: { role: existing.role.name, status: existing.status, name: existing.name },
    newValue: { role: nextRole, status: nextStatus, name: user.name },
  })
  return toPublicUser(user)
}

export async function resetUserPassword(id: string, actor: AuthUser, req: Request) {
  const existing = await prisma.user.findUnique({ where: { id } })
  if (!existing) throw notFound('User not found.')
  const temporaryPassword = `Reset@${crypto.randomBytes(3).toString('hex')}9A`
  await prisma.user.update({
    where: { id },
    data: { passwordHash: await bcrypt.hash(temporaryPassword, 10), failedLoginCount: 0, lockedUntil: null, status: existing.status === 'LOCKED' ? 'ACTIVE' : existing.status },
  })
  await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } })
  await writeAudit({ user: actor, action: 'RESET_USER_PASSWORD', resource: 'USER', resourceId: id, req })
  return { temporaryPassword, email: 'Email delivery is disabled in demo environment.' }
}

export async function updateProfile(id: string, input: {
  name?: string
  timezone?: string
  theme?: 'light' | 'dark' | 'system'
  notifyIncidents?: boolean
  notifyAnomalies?: boolean
  notifyReports?: boolean
  notifySecurity?: boolean
  currentPassword?: string
  newPassword?: string
}, req: Request) {
  const existing = await prisma.user.findUnique({ where: { id }, include: { role: true } })
  if (!existing) throw notFound('User not found.')
  if (input.newPassword) {
    if (!input.currentPassword) throw conflict('Current password is required.')
    const matches = await bcrypt.compare(input.currentPassword, existing.passwordHash)
    if (!matches) throw conflict('Current password is incorrect.')
  }
  const user = await prisma.user.update({
    where: { id },
    data: {
      name: input.name ?? existing.name,
      timezone: input.timezone ?? existing.timezone,
      theme: input.theme ?? existing.theme,
      notifyIncidents: input.notifyIncidents ?? existing.notifyIncidents,
      notifyAnomalies: input.notifyAnomalies ?? existing.notifyAnomalies,
      notifyReports: input.notifyReports ?? existing.notifyReports,
      notifySecurity: input.notifySecurity ?? existing.notifySecurity,
      ...(input.newPassword ? { passwordHash: await bcrypt.hash(input.newPassword, 10) } : {}),
    },
    include: { role: true },
  })
  await writeAudit({
    user,
    action: input.newPassword ? 'PASSWORD_CHANGED' : 'UPDATED_PROFILE',
    resource: 'USER',
    resourceId: id,
    req,
  })
  return toPublicUser(user)
}

export async function updateThresholds(input: {
  highValueAmount?: number
  failureRatePct?: number
  latencyMs?: number
  availabilityPct?: number
  volumeAnomalyPct?: number
  repeatedFailureCount?: number
}, actor: AuthUser, req: Request) {
  const previous = await prisma.thresholdConfig.findUnique({ where: { id: 'default' } })
  const row = await prisma.thresholdConfig.upsert({
    where: { id: 'default' },
    update: input,
    create: { id: 'default', ...input },
  })
  const { clearThresholdCache } = await import('./thresholds.js')
  clearThresholdCache()
  await writeAudit({
    user: actor,
    action: 'UPDATED_THRESHOLDS',
    resource: 'SETTINGS',
    resourceId: 'thresholds',
    req,
    previousValue: previous ? { highValueAmount: previous.highValueAmount, failureRatePct: previous.failureRatePct } : undefined,
    newValue: input,
  })
  return row
}
