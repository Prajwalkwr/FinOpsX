import type { IncidentSeverity, IncidentStatus } from '@prisma/client'
import type { Request } from 'express'
import { forbidden, notFound } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'
import { pageOf } from '../lib/http.js'
import { writeAudit } from './audit.js'
import { notifyUsers } from './notify.js'
import { getThresholds } from './thresholds.js'

const ACTIVE = ['OPEN', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATING'] as IncidentStatus[]

export function incidentSummary(input: {
  title: string
  severity: string
  service?: string
  institution?: string
  failureRate?: number
  latencyMs?: number
}) {
  return [
    `Summary: ${input.title}.`,
    input.failureRate != null ? `Evidence: recent failure rate is ${input.failureRate.toFixed(1)}%.` : 'Evidence: derived from synthetic operational metrics.',
    input.latencyMs != null ? `Observed latency is ${Math.round(input.latencyMs)}ms.` : '',
    `Likely explanation: ${input.service ?? 'a monitored service'}${input.institution ? ` at ${input.institution}` : ''} is outside its normal range.`,
    'Recommended next steps: confirm the affected service, review timeout responses, and check the incident timeline.',
    'Limitation: AI-generated analysis — verify before taking operational action. This is based on synthetic demo data and is an analytical inference, not proof.',
  ].filter(Boolean).join('\n')
}

export async function raiseIncident(input: {
  title: string
  description: string
  severity: IncidentSeverity
  incidentType: string
  serviceIds?: string[]
  institutionIds?: string[]
  affectedTransactionCount?: number
  failureRate?: number
  latencyMs?: number
}) {
  const thresholds = await getThresholds()
  const windowStart = new Date(Date.now() - thresholds.dedupWindowMinutes * 60_000)
  const existing = await prisma.incident.findFirst({
    where: {
      status: { in: ACTIVE },
      createdAt: { gte: windowStart },
      OR: [
        { incidentType: input.incidentType },
        input.serviceIds?.length ? { services: { some: { serviceId: { in: input.serviceIds } } } } : { id: '__none__' },
      ],
    },
  })
  if (existing) {
    await prisma.incident.update({
      where: { id: existing.id },
      data: {
        affectedTransactionCount: Math.max(existing.affectedTransactionCount, input.affectedTransactionCount ?? 0),
        severity: rank(input.severity) > rank(existing.severity) ? input.severity : existing.severity,
        description: input.description,
      },
    })
    await prisma.incidentEvent.create({
      data: {
        incidentId: existing.id,
        message: 'Correlated signal updated this incident instead of opening a duplicate. These events appear correlated because they occurred within the same time window and involve the same service. This is an analytical inference, not absolute proof.',
        actorEmail: 'system@finopsx.demo',
      },
    })
    emit('incident:updated', { id: existing.publicId, status: existing.status })
    return prisma.incident.findUnique({ where: { id: existing.id } })
  }
  const count = await prisma.incident.count()
  const services = input.serviceIds ?? []
  const institutions = input.institutionIds ?? []
  const serviceName = services.length
    ? (await prisma.service.findUnique({ where: { id: services[0] } }))?.name
    : undefined
  const institutionName = institutions.length
    ? (await prisma.institution.findUnique({ where: { id: institutions[0] } }))?.name
    : undefined
  const created = await prisma.incident.create({
    data: {
      publicId: `INC-${1000 + count + 1}`,
      title: input.title,
      description: input.description,
      severity: input.severity,
      status: 'OPEN',
      incidentType: input.incidentType,
      affectedTransactionCount: input.affectedTransactionCount ?? 0,
      detectedAt: new Date(),
      aiSummary: incidentSummary({
        title: input.title,
        severity: input.severity,
        service: serviceName,
        institution: institutionName,
        failureRate: input.failureRate,
        latencyMs: input.latencyMs,
      }),
      events: {
        create: [
          { message: input.description, actorEmail: 'system@finopsx.demo' },
          { message: 'Anomaly detector and incident rules evaluated the live window.', actorEmail: 'system@finopsx.demo' },
        ],
      },
      services: { create: services.map((serviceId) => ({ serviceId })) },
      institutions: { create: institutions.map((institutionId) => ({ institutionId })) },
    },
  })
  await notifyUsers({
    preference: 'notifyIncidents',
    roles: ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ENGINEER', 'ANALYST'],
    type: 'INCIDENT',
    title: `${input.severity} incident opened`,
    message: input.title,
    severity: input.severity,
    link: `/incidents/${created.publicId}`,
  })
  await writeAudit({
    actorEmail: 'system@finopsx.demo',
    action: 'CREATED_INCIDENT',
    resource: 'INCIDENT',
    resourceId: created.publicId,
    newValue: { severity: input.severity, type: input.incidentType },
  })
  emit('incident:created', { id: created.publicId, title: created.title, severity: created.severity })
  return created
}

function rank(severity: string) {
  return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(severity)
}

export async function listIncidents(query: { page: number; limit: number; status?: string; severity?: string; q?: string }) {
  const where = {
    ...(query.status ? { status: query.status as IncidentStatus } : {}),
    ...(query.severity ? { severity: query.severity as IncidentSeverity } : {}),
    ...(query.q
      ? {
          OR: [
            { publicId: { contains: query.q, mode: 'insensitive' as const } },
            { title: { contains: query.q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  }
  const skip = (query.page - 1) * query.limit
  const [total, rows] = await prisma.$transaction([
    prisma.incident.count({ where }),
    prisma.incident.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: query.limit,
      include: { assignee: true, services: { include: { service: true } }, institutions: { include: { institution: true } } },
    }),
  ])
  return pageOf(rows.map(serializeIncident), total, query.page, query.limit)
}

export async function getIncident(id: string) {
  const row = await prisma.incident.findFirst({
    where: { OR: [{ id }, { publicId: id }] },
    include: {
      assignee: true,
      events: { orderBy: { createdAt: 'asc' } },
      services: { include: { service: true } },
      institutions: { include: { institution: true } },
      anomalies: true,
    },
  })
  if (!row) throw notFound('Incident not found.')
  return {
    ...serializeIncident(row),
    description: row.description,
    rootCause: row.rootCause,
    resolution: row.resolution,
    aiSummary: row.aiSummary,
    aiLabel: 'AI-generated analysis — verify before taking operational action.',
    timeline: row.events.map((event) => ({
      id: event.id,
      message: event.message,
      actorEmail: event.actorEmail,
      timestamp: event.createdAt.toISOString(),
    })),
    anomalies: row.anomalies.map((item) => ({ id: item.publicId, title: item.title, type: item.type, status: item.status })),
  }
}

function serializeIncident(row: {
  id: string
  publicId: string
  title: string
  severity: string
  status: string
  incidentType: string
  affectedTransactionCount: number
  detectedAt: Date
  resolvedAt: Date | null
  createdAt: Date
  assignee?: { id: string; name: string; email: string } | null
  services?: Array<{ service: { id: string; name: string } }>
  institutions?: Array<{ institution: { id: string; name: string } }>
}) {
  return {
    id: row.id,
    publicId: row.publicId,
    title: row.title,
    severity: row.severity,
    status: row.status,
    incidentType: row.incidentType,
    affectedTransactionCount: row.affectedTransactionCount,
    detectedAt: row.detectedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    assignee: row.assignee ? { id: row.assignee.id, name: row.assignee.name, email: row.assignee.email } : null,
    services: row.services?.map((item) => item.service) ?? [],
    institutions: row.institutions?.map((item) => item.institution) ?? [],
  }
}

export async function createIncident(input: {
  title: string
  description: string
  severity: IncidentSeverity
  serviceIds?: string[]
  institutionIds?: string[]
}, user: AuthUser, req: Request) {
  const created = await raiseIncident({
    ...input,
    incidentType: 'MANUAL',
  })
  if (!created) throw notFound('Incident could not be created.')
  await prisma.incidentEvent.create({
    data: { incidentId: created.id, message: `Opened by ${user.email}.`, actorEmail: user.email },
  })
  await writeAudit({
    user,
    action: 'CREATED_INCIDENT',
    resource: 'INCIDENT',
    resourceId: created.publicId,
    req,
    newValue: { title: input.title, severity: input.severity },
  })
  return getIncident(created.publicId)
}

export async function updateIncident(id: string, input: {
  status?: IncidentStatus
  assigneeId?: string | null
  rootCause?: string
  resolution?: string
  note?: string
  severity?: IncidentSeverity
}, user: AuthUser, req: Request) {
  const current = await prisma.incident.findFirst({
    where: { OR: [{ id }, { publicId: id }] },
    include: { assignee: true },
  })
  if (!current) throw notFound('Incident not found.')
  if (input.assigneeId !== undefined && user.role === 'ENGINEER') {
    throw forbidden('Only an operations manager or super admin can assign incidents.')
  }
  if (user.role === 'ENGINEER' && current.assigneeId && current.assigneeId !== user.id && input.status) {
    throw forbidden('This incident is assigned to another engineer.')
  }
  const data: {
    status?: IncidentStatus
    assigneeId?: string | null
    rootCause?: string
    resolution?: string
    severity?: IncidentSeverity
    resolvedAt?: Date | null
  } = {}
  if (input.status) data.status = input.status
  if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId
  if (input.rootCause !== undefined) data.rootCause = input.rootCause
  if (input.resolution !== undefined) data.resolution = input.resolution
  if (input.severity) data.severity = input.severity
  if (input.status === 'RESOLVED' || input.status === 'CLOSED') data.resolvedAt = new Date()
  const updated = await prisma.incident.update({ where: { id: current.id }, data })
  const notes: string[] = []
  if (input.note) notes.push(input.note)
  if (input.status && input.status !== current.status) notes.push(`Status changed from ${current.status} to ${input.status}.`)
  if (input.assigneeId) notes.push('Engineer assigned.')
  if (input.status === 'RESOLVED') notes.push('Incident resolved.')
  if (notes.length) {
    await prisma.incidentEvent.createMany({
      data: notes.map((message) => ({ incidentId: current.id, message, actorEmail: user.email })),
    })
  }
  await writeAudit({
    user,
    action: input.status === 'RESOLVED' ? 'RESOLVED_INCIDENT' : input.assigneeId ? 'ASSIGNED_INCIDENT' : 'UPDATED_INCIDENT',
    resource: 'INCIDENT',
    resourceId: current.publicId,
    req,
    previousValue: { status: current.status, assigneeId: current.assigneeId },
    newValue: { status: updated.status, assigneeId: updated.assigneeId },
  })
  if (input.assigneeId) {
    await notifyUsers({
      userIds: [input.assigneeId],
      preference: 'notifyIncidents',
      type: 'INCIDENT_ASSIGNED',
      title: 'Incident assigned to you',
      message: current.title,
      severity: current.severity,
      link: `/incidents/${current.publicId}`,
    })
  }
  if (input.status === 'RESOLVED') {
    await notifyUsers({
      preference: 'notifyIncidents',
      roles: ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ENGINEER'],
      type: 'INCIDENT_RESOLVED',
      title: 'Incident resolved',
      message: current.title,
      severity: 'LOW',
      link: `/incidents/${current.publicId}`,
    })
    emit('incident:resolved', { id: current.publicId })
  } else {
    emit('incident:updated', { id: current.publicId, status: updated.status })
  }
  return getIncident(current.publicId)
}
