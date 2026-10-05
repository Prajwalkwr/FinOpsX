import type { IncidentSeverity, IncidentStatus, Prisma } from '@prisma/client'
import type { Request } from 'express'
import { badRequest, forbidden, notFound, unprocessable } from '../lib/errors.js'
import type { AuthUser } from '../lib/http.js'
import { pageOf } from '../lib/http.js'
import { createWithPublicId } from '../lib/ids.js'
import { prisma } from '../lib/prisma.js'
import { emit } from '../lib/realtime.js'
import { writeAudit } from './audit.js'
import { notifyUsers } from './notify.js'
import { analyzeIncident, RELATED_ANOMALY_TYPES, summarizeRca, type RcaResult } from './rcaService.js'
import { getThresholds } from './thresholds.js'

export const ACTIVE_STATUSES: IncidentStatus[] = ['DETECTED', 'ACKNOWLEDGED', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATING']
export const LIFECYCLE: IncidentStatus[] = ['DETECTED', 'ACKNOWLEDGED', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATING', 'RESOLVED', 'POST_INCIDENT_REVIEW']

const TEAM_BY_SERVICE: Record<string, string> = {
  'bank-api': 'Integrations',
  'wallet-service': 'Integrations',
  'payment-api': 'Payments Core',
  'payment-gateway': 'Edge Platform',
  'merchant-api': 'Merchant Platform',
  'settlement-service': 'Settlements',
  'notification-service': 'Messaging',
  'auth-service': 'Identity',
  'transaction-db': 'Data Platform',
  redis: 'Data Platform',
  'ai-service': 'Data Platform',
}

/** Forward-only transitions; going back requires an explicit reopen. */
export function canTransition(from: IncidentStatus, to: IncidentStatus) {
  if (from === to) return false
  const a = LIFECYCLE.indexOf(from)
  const b = LIFECYCLE.indexOf(to)
  if (to === 'POST_INCIDENT_REVIEW') return from === 'RESOLVED'
  if (from === 'RESOLVED' || from === 'POST_INCIDENT_REVIEW') return false
  return b > a
}

function rank(severity: string) {
  return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(severity)
}

const SYSTEM = 'system@finopsx.demo'

async function event(incidentId: string, kind: string, message: string, actorEmail = SYSTEM) {
  await prisma.incidentEvent.create({ data: { incidentId, kind, message, actorEmail } })
}

export async function refreshRca(incidentId: string) {
  const incident = await prisma.incident.findUniqueOrThrow({ where: { id: incidentId } })
  const rca = await analyzeIncident(incidentId)
  await prisma.incident.update({
    where: { id: incidentId },
    data: { rca: rca as unknown as Prisma.InputJsonValue, aiSummary: summarizeRca(incident.title, rca, incident.rootCause) },
  })
  return rca
}

export async function raiseIncident(input: {
  title: string
  description: string
  severity: IncidentSeverity
  incidentType: string
  serviceIds?: string[]
  institutionIds?: string[]
  affectedTransactionCount?: number
  scenario?: string | null
  actorEmail?: string
}) {
  const thresholds = await getThresholds()
  const windowStart = new Date(Date.now() - thresholds.dedupWindowMinutes * 60_000)
  const correlation: Prisma.IncidentWhereInput[] = [{ incidentType: input.incidentType, ...(input.serviceIds?.length ? { services: { some: { serviceId: { in: input.serviceIds } } } } : {}) }]
  if (input.scenario) correlation.push({ scenario: input.scenario })
  if (input.serviceIds?.length) correlation.push({ services: { some: { serviceId: { in: input.serviceIds } } } })
  const existing = input.incidentType === 'MANUAL'
    ? null
    : await prisma.incident.findFirst({ where: { status: { in: ACTIVE_STATUSES }, createdAt: { gte: windowStart }, OR: correlation } })
  if (existing) {
    const severity = rank(input.severity) > rank(existing.severity) ? input.severity : existing.severity
    await prisma.incident.update({
      where: { id: existing.id },
      data: {
        affectedTransactionCount: Math.max(existing.affectedTransactionCount, input.affectedTransactionCount ?? 0),
        severity,
        ...(input.scenario && !existing.scenario ? { scenario: input.scenario } : {}),
        services: { connectOrCreate: (input.serviceIds ?? []).map((serviceId) => ({ where: { incidentId_serviceId: { incidentId: existing.id, serviceId } }, create: { serviceId } })) },
        institutions: { connectOrCreate: (input.institutionIds ?? []).map((institutionId) => ({ where: { incidentId_institutionId: { incidentId: existing.id, institutionId } }, create: { institutionId } })) },
      },
    })
    const recent = await prisma.incidentEvent.findFirst({ where: { incidentId: existing.id, kind: 'CORRELATED', createdAt: { gte: new Date(Date.now() - 5 * 60_000) } } })
    if (!recent) {
      await event(existing.id, 'CORRELATED', `Correlated signal: ${input.title}. ${input.description} Linked to this incident instead of opening a duplicate because it occurred in the same window and involves the same service or scenario. This is an analytical inference, not proof.`)
    }
    if (severity !== existing.severity) await event(existing.id, 'SEVERITY', `Severity raised automatically from ${existing.severity} to ${severity}.`)
    emit('incident:updated', { id: existing.publicId, status: existing.status })
    return { incident: existing, created: false }
  }
  const services = input.serviceIds?.length ? await prisma.service.findMany({ where: { id: { in: input.serviceIds } } }) : []
  const created = await createWithPublicId(
    async () => 2040 + (await prisma.incident.count()) + 1,
    (n) => `INC-${n}`,
    (publicId) => prisma.incident.create({
      data: {
        publicId,
        title: input.title,
        description: input.description,
        severity: input.severity,
        status: 'DETECTED',
        incidentType: input.incidentType,
        team: services[0] ? TEAM_BY_SERVICE[services[0].key] ?? null : null,
        scenario: input.scenario ?? null,
        affectedTransactionCount: input.affectedTransactionCount ?? 0,
        detectedAt: new Date(),
        events: { create: [{ kind: 'DETECTED', message: input.description, actorEmail: input.actorEmail ?? SYSTEM }] },
        services: { create: (input.serviceIds ?? []).map((serviceId) => ({ serviceId })) },
        institutions: { create: (input.institutionIds ?? []).map((institutionId) => ({ institutionId })) },
      },
    }),
  )
  const relatedTypes = RELATED_ANOMALY_TYPES[input.incidentType] ?? []
  const linked = relatedTypes.length
    ? await prisma.anomaly.updateMany({
      where: {
        incidentId: null,
        type: { in: relatedTypes },
        status: { in: ['DETECTED', 'REVIEW', 'CONFIRMED'] },
        detectedAt: { gte: new Date(Date.now() - 15 * 60_000) },
        ...(input.institutionIds?.length ? { OR: [{ institutionId: { in: input.institutionIds } }, { institutionId: null }] } : {}),
      },
      data: { incidentId: created.id },
    })
    : { count: 0 }
  if (linked.count) await event(created.id, 'CORRELATED', `${linked.count} recent anomal${linked.count === 1 ? 'y was' : 'ies were'} linked to this incident by time window and scope.`)
  await refreshRca(created.id).catch(() => undefined)
  await event(created.id, 'RCA', 'AI-assisted root cause analysis generated from live metrics. Verify before acting.')
  await notifyUsers({
    preference: 'notifyIncidents',
    roles: ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ENGINEER'],
    type: 'INCIDENT',
    title: `${input.severity} incident ${created.publicId} detected`,
    message: input.title,
    severity: input.severity,
    link: `/incidents/${created.publicId}`,
  })
  await writeAudit({ actorEmail: input.actorEmail ?? SYSTEM, action: 'CREATED_INCIDENT', resource: 'INCIDENT', resourceId: created.publicId, newValue: { severity: input.severity, type: input.incidentType, scenario: input.scenario ?? null } })
  emit('incident:created', { id: created.publicId, title: created.title, severity: created.severity })
  return { incident: created, created: true }
}

const LIST_INCLUDE = { assignee: true, services: { include: { service: true } }, institutions: { include: { institution: true } } } satisfies Prisma.IncidentInclude
type ListRow = Prisma.IncidentGetPayload<{ include: typeof LIST_INCLUDE }>

function serializeIncident(row: ListRow) {
  return {
    id: row.id,
    publicId: row.publicId,
    title: row.title,
    severity: row.severity,
    status: row.status,
    incidentType: row.incidentType,
    team: row.team,
    scenario: row.scenario,
    affectedTransactionCount: row.affectedTransactionCount,
    detectedAt: row.detectedAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    reopenCount: row.reopenCount,
    assignee: row.assignee ? { id: row.assignee.id, name: row.assignee.name, email: row.assignee.email } : null,
    services: row.services.map((item) => ({ id: item.service.id, key: item.service.key, name: item.service.name, status: item.service.status })),
    institutions: row.institutions.map((item) => ({ id: item.institution.id, code: item.institution.code, name: item.institution.name })),
  }
}

export async function listIncidents(query: { page: number; limit: number; status?: string; severity?: string; q?: string; active?: boolean }) {
  const where: Prisma.IncidentWhereInput = {
    ...(query.status ? { status: query.status as IncidentStatus } : query.active ? { status: { in: ACTIVE_STATUSES } } : {}),
    ...(query.severity ? { severity: query.severity as IncidentSeverity } : {}),
    ...(query.q
      ? { OR: [{ publicId: { contains: query.q, mode: 'insensitive' } }, { title: { contains: query.q, mode: 'insensitive' } }] }
      : {}),
  }
  const skip = (query.page - 1) * query.limit
  const [total, rows] = await prisma.$transaction([
    prisma.incident.count({ where }),
    prisma.incident.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: query.limit, include: LIST_INCLUDE }),
  ])
  return pageOf(rows.map(serializeIncident), total, query.page, query.limit)
}

async function findIncident(id: string) {
  const row = await prisma.incident.findFirst({ where: { OR: [{ id }, { publicId: id }] }, include: { assignee: true } })
  if (!row) throw notFound('Incident not found.')
  return row
}

export async function getIncident(id: string) {
  const row = await prisma.incident.findFirst({
    where: { OR: [{ id }, { publicId: id }] },
    include: { ...LIST_INCLUDE, events: { orderBy: { createdAt: 'asc' } }, anomalies: { orderBy: { detectedAt: 'desc' } } },
  })
  if (!row) throw notFound('Incident not found.')
  const affectedWhere: Prisma.TransactionWhereInput = {
    status: 'FAILED',
    createdAt: { gte: new Date(row.detectedAt.getTime() - 10 * 60_000), lte: row.resolvedAt ?? new Date() },
    ...(row.institutions.length ? { institutionId: { in: row.institutions.map((item) => item.institutionId) } } : {}),
  }
  const [affected, affectedCount] = await Promise.all([
    prisma.transaction.findMany({ where: affectedWhere, orderBy: { createdAt: 'desc' }, take: 10, include: { institution: true } }),
    prisma.transaction.count({ where: affectedWhere }),
  ])
  return {
    ...serializeIncident(row),
    affectedTransactionCount: Math.max(row.affectedTransactionCount, affectedCount),
    description: row.description,
    rootCause: row.rootCause,
    rootCauseConfirmed: row.rootCauseConfirmed,
    resolution: row.resolution,
    preventiveAction: row.preventiveAction,
    aiSummary: row.aiSummary,
    rca: (row.rca as unknown as RcaResult | null) ?? null,
    aiLabel: 'AI-generated analysis — verify before taking operational action.',
    allowedTransitions: LIFECYCLE.filter((status) => canTransition(row.status, status)),
    timeline: row.events.map((item) => ({ id: item.id, kind: item.kind, message: item.message, actorEmail: item.actorEmail, timestamp: item.createdAt.toISOString() })),
    anomalies: row.anomalies.map((item) => ({ publicId: item.publicId, title: item.title, type: item.type, status: item.status, severity: item.severity, detectedAt: item.detectedAt })),
    affectedTransactions: affected.map((tx) => ({ transactionId: tx.transactionId, institution: tx.institution.name, failureReason: tx.failureReason, responseTimeMs: tx.responseTimeMs, createdAt: tx.createdAt.toISOString() })),
  }
}

/** Engineers act only on incidents assigned to them; acting on an unassigned incident takes ownership. */
async function guardEngineer(incident: Awaited<ReturnType<typeof findIncident>>, user: AuthUser) {
  if (user.role !== 'ENGINEER') return
  if (incident.assigneeId && incident.assigneeId !== user.id) throw forbidden('This incident is assigned to another engineer.')
  if (!incident.assigneeId) {
    await prisma.incident.update({ where: { id: incident.id }, data: { assigneeId: user.id } })
    await event(incident.id, 'ASSIGNMENT', `${user.email} took ownership of the incident.`, user.email)
  }
}

export async function createIncident(input: { title: string; description: string; severity: IncidentSeverity; serviceIds?: string[]; institutionIds?: string[] }, user: AuthUser, req: Request) {
  const { incident } = await raiseIncident({ ...input, incidentType: 'MANUAL', actorEmail: user.email })
  await writeAudit({ user, action: 'CREATED_INCIDENT', resource: 'INCIDENT', resourceId: incident.publicId, req, newValue: { title: input.title, severity: input.severity } })
  return getIncident(incident.publicId)
}

export async function changeStatus(id: string, input: { status: IncidentStatus; note?: string }, user: AuthUser, req: Request) {
  const incident = await findIncident(id)
  await guardEngineer(incident, user)
  if (input.status === 'RESOLVED') return resolveIncident(id, { resolution: input.note ?? '' }, user, req)
  if (!canTransition(incident.status, input.status)) {
    throw unprocessable(`Cannot move an incident from ${incident.status} to ${input.status}.`, { allowed: LIFECYCLE.filter((status) => canTransition(incident.status, status)) })
  }
  await prisma.incident.update({
    where: { id: incident.id },
    data: { status: input.status, ...(input.status === 'ACKNOWLEDGED' && !incident.acknowledgedAt ? { acknowledgedAt: new Date() } : {}) },
  })
  await event(incident.id, 'STATUS', `Status changed from ${incident.status} to ${input.status}.${input.note ? ` Note: ${input.note}` : ''}`, user.email)
  await writeAudit({ user, action: 'CHANGED_INCIDENT_STATUS', resource: 'INCIDENT', resourceId: incident.publicId, req, previousValue: { status: incident.status }, newValue: { status: input.status, note: input.note ?? null } })
  emit('incident:updated', { id: incident.publicId, status: input.status })
  return getIncident(incident.publicId)
}

export async function assignIncident(id: string, input: { assigneeId: string | null; team?: string }, user: AuthUser, req: Request) {
  const incident = await findIncident(id)
  let assignee: { id: string; email: string; name: string } | null = null
  if (input.assigneeId) {
    assignee = await prisma.user.findFirst({ where: { id: input.assigneeId, status: 'ACTIVE', role: { name: { in: ['ENGINEER', 'OPERATIONS_MANAGER', 'SUPER_ADMIN'] } } }, select: { id: true, email: true, name: true } })
    if (!assignee) throw badRequest('Assignee must be an active engineer, operations manager, or super admin.')
  }
  await prisma.incident.update({ where: { id: incident.id }, data: { assigneeId: input.assigneeId, ...(input.team !== undefined ? { team: input.team } : {}) } })
  await event(incident.id, 'ASSIGNMENT', assignee ? `Assigned to ${assignee.name} (${assignee.email})${input.team ? `, team ${input.team}` : ''}.` : 'Assignment cleared.', user.email)
  await writeAudit({ user, action: 'ASSIGNED_INCIDENT', resource: 'INCIDENT', resourceId: incident.publicId, req, previousValue: { assigneeId: incident.assigneeId, team: incident.team }, newValue: { assigneeId: input.assigneeId, team: input.team ?? incident.team } })
  if (assignee) {
    await notifyUsers({ userIds: [assignee.id], preference: 'notifyIncidents', type: 'INCIDENT_ASSIGNED', title: `${incident.publicId} assigned to you`, message: incident.title, severity: incident.severity, link: `/incidents/${incident.publicId}` })
  }
  emit('incident:updated', { id: incident.publicId, status: incident.status })
  return getIncident(incident.publicId)
}

export async function changeSeverity(id: string, input: { severity: IncidentSeverity; reason?: string }, user: AuthUser, req: Request) {
  const incident = await findIncident(id)
  await guardEngineer(incident, user)
  if (incident.severity === input.severity) throw unprocessable(`Severity is already ${input.severity}.`)
  await prisma.incident.update({ where: { id: incident.id }, data: { severity: input.severity } })
  await event(incident.id, 'SEVERITY', `Severity changed from ${incident.severity} to ${input.severity}.${input.reason ? ` Reason: ${input.reason}` : ''}`, user.email)
  await writeAudit({ user, action: 'CHANGED_INCIDENT_SEVERITY', resource: 'INCIDENT', resourceId: incident.publicId, req, previousValue: { severity: incident.severity }, newValue: { severity: input.severity, reason: input.reason ?? null } })
  emit('incident:updated', { id: incident.publicId, status: incident.status })
  return getIncident(incident.publicId)
}

export async function addNote(id: string, input: { message: string }, user: AuthUser, req: Request) {
  const incident = await findIncident(id)
  await guardEngineer(incident, user)
  await event(incident.id, 'NOTE', input.message, user.email)
  await writeAudit({ user, action: 'ADDED_INCIDENT_NOTE', resource: 'INCIDENT', resourceId: incident.publicId, req, newValue: { message: input.message } })
  emit('incident:updated', { id: incident.publicId, status: incident.status })
  return getIncident(incident.publicId)
}

export async function updateDetails(id: string, input: { rootCause?: string; rootCauseConfirmed?: boolean; preventiveAction?: string; team?: string; title?: string }, user: AuthUser, req: Request) {
  const incident = await findIncident(id)
  await guardEngineer(incident, user)
  const data: Prisma.IncidentUpdateInput = {}
  if (input.rootCause !== undefined) data.rootCause = input.rootCause
  if (input.rootCauseConfirmed !== undefined) data.rootCauseConfirmed = input.rootCauseConfirmed
  if (input.preventiveAction !== undefined) data.preventiveAction = input.preventiveAction
  if (input.team !== undefined) data.team = input.team
  if (input.title !== undefined) data.title = input.title
  if (input.rootCauseConfirmed && !(input.rootCause ?? incident.rootCause)) throw unprocessable('Add a root cause before confirming it.')
  await prisma.incident.update({ where: { id: incident.id }, data })
  const changed = Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined)
  await event(incident.id, 'DETAILS', `Updated ${changed.join(', ')}.${input.rootCauseConfirmed ? ' Root cause confirmed by a human reviewer.' : ''}`, user.email)
  await writeAudit({
    user,
    action: 'UPDATED_INCIDENT',
    resource: 'INCIDENT',
    resourceId: incident.publicId,
    req,
    previousValue: { rootCause: incident.rootCause, rootCauseConfirmed: incident.rootCauseConfirmed, preventiveAction: incident.preventiveAction, team: incident.team },
    newValue: input as Prisma.InputJsonValue,
  })
  if (input.rootCauseConfirmed !== undefined || input.rootCause !== undefined) await refreshRca(incident.id).catch(() => undefined)
  emit('incident:updated', { id: incident.publicId, status: incident.status })
  return getIncident(incident.publicId)
}

export async function resolveIncident(id: string, input: { resolution: string; rootCause?: string; preventiveAction?: string }, user: AuthUser, req: Request) {
  const incident = await findIncident(id)
  await guardEngineer(incident, user)
  if (!ACTIVE_STATUSES.includes(incident.status)) throw unprocessable(`Incident is already ${incident.status}.`)
  if (!input.resolution.trim()) throw unprocessable('A resolution summary is required to resolve an incident.', { field: 'resolution' })
  const now = new Date()
  await prisma.incident.update({
    where: { id: incident.id },
    data: {
      status: 'RESOLVED',
      resolvedAt: now,
      resolution: input.resolution,
      ...(input.rootCause ? { rootCause: input.rootCause } : {}),
      ...(input.preventiveAction ? { preventiveAction: input.preventiveAction } : {}),
    },
  })
  await event(incident.id, 'RESOLUTION', `Resolved: ${input.resolution}`, user.email)
  await writeAudit({ user, action: 'RESOLVED_INCIDENT', resource: 'INCIDENT', resourceId: incident.publicId, req, previousValue: { status: incident.status }, newValue: { status: 'RESOLVED', resolution: input.resolution } })
  await prisma.anomaly.updateMany({ where: { incidentId: incident.id, status: { in: ['DETECTED', 'REVIEW', 'CONFIRMED'] } }, data: { status: 'RESOLVED', resolvedAt: now } })
  if (incident.scenario) {
    const { currentConfig, resolveScenario } = await import('../simulator/engine.js')
    const config = await currentConfig()
    if (config.scenario === incident.scenario) {
      await resolveScenario({ resolveIncidents: false, actorEmail: user.email })
      await event(incident.id, 'SYSTEM', 'Demo scenario ended; simulated service metrics are recovering.')
    }
  }
  await notifyUsers({ preference: 'notifyIncidents', roles: ['SUPER_ADMIN', 'OPERATIONS_MANAGER', 'ENGINEER'], type: 'INCIDENT_RESOLVED', title: `${incident.publicId} resolved`, message: incident.title, severity: 'LOW', link: `/incidents/${incident.publicId}` })
  await refreshRca(incident.id).catch(() => undefined)
  emit('incident:resolved', { id: incident.publicId })
  return getIncident(incident.publicId)
}

export async function reopenIncident(id: string, input: { reason: string }, user: AuthUser, req: Request) {
  const incident = await findIncident(id)
  if (incident.status !== 'RESOLVED' && incident.status !== 'POST_INCIDENT_REVIEW') throw unprocessable('Only resolved incidents can be reopened.')
  await prisma.incident.update({ where: { id: incident.id }, data: { status: 'INVESTIGATING', resolvedAt: null, reopenCount: { increment: 1 } } })
  await event(incident.id, 'REOPEN', `Reopened from ${incident.status}: ${input.reason}`, user.email)
  await writeAudit({ user, action: 'REOPENED_INCIDENT', resource: 'INCIDENT', resourceId: incident.publicId, req, previousValue: { status: incident.status }, newValue: { status: 'INVESTIGATING', reason: input.reason } })
  emit('incident:updated', { id: incident.publicId, status: 'INVESTIGATING' })
  return getIncident(incident.publicId)
}

export async function rerunRca(id: string, user: AuthUser, req: Request) {
  const incident = await findIncident(id)
  const rca = await refreshRca(incident.id)
  await event(incident.id, 'RCA', `Root cause analysis re-run by ${user.email}.`, user.email)
  await writeAudit({ user, action: 'RAN_RCA', resource: 'INCIDENT', resourceId: incident.publicId, req, newValue: { likelyCause: rca.likelyCause, confidence: rca.confidence } })
  return getIncident(incident.publicId)
}
