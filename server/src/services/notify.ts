import { prisma } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'

export async function notifyUsers(input: {
  roles?: Array<'SUPER_ADMIN' | 'OPERATIONS_MANAGER' | 'ANALYST' | 'ENGINEER' | 'AUDITOR'>
  userIds?: string[]
  preference?: 'notifyIncidents' | 'notifyAnomalies' | 'notifyReports' | 'notifySecurity'
  type: string
  title: string
  message: string
  severity: string
  link?: string
}) {
  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      ...(input.preference ? { [input.preference]: true } : {}),
      ...(input.userIds ? { id: { in: input.userIds } } : {}),
      ...(input.roles ? { role: { name: { in: input.roles } } } : {}),
    },
    select: { id: true },
  })
  if (!users.length) return
  await prisma.notification.createMany({
    data: users.map((user) => ({
      userId: user.id,
      type: input.type,
      title: input.title,
      message: input.message,
      severity: input.severity,
      link: input.link,
    })),
  })
  emit('notification:created', { type: input.type, severity: input.severity })
}
