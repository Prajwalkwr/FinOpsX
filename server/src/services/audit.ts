import type { Prisma } from '@prisma/client'
import type { Request } from 'express'
import type { AuthUser } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'

export async function writeAudit(input: {
  user?: Pick<AuthUser, 'id' | 'email'> | null
  actorEmail?: string
  action: string
  resource: string
  resourceId?: string | null
  req?: Request
  previousValue?: Prisma.InputJsonValue
  newValue?: Prisma.InputJsonValue
}) {
  await prisma.auditLog.create({
    data: {
      userId: input.user?.id,
      actorEmail: input.actorEmail ?? input.user?.email ?? 'system@finopsx.demo',
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId ?? null,
      ipAddress: input.req?.ip ?? null,
      userAgent: input.req?.header('user-agent')?.slice(0, 240) ?? null,
      previousValue: input.previousValue,
      newValue: input.newValue,
    },
  })
}
