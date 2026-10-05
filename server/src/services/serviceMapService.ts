import { prisma } from '../lib/prisma.js'
import { ACTIVE_STATUSES } from './incidentService.js'

/** Returns every service that directly or transitively calls the given service. */
export function transitiveDependents(serviceId: string, edges: Array<{ from: string; to: string }>) {
  const impacted = new Set<string>()
  const queue = [serviceId]
  while (queue.length) {
    const current = queue.shift()!
    for (const edge of edges) {
      if (edge.to === current && !impacted.has(edge.from) && edge.from !== serviceId) {
        impacted.add(edge.from)
        queue.push(edge.from)
      }
    }
  }
  return [...impacted]
}

export async function serviceMap() {
  const [services, dependencies, incidents] = await Promise.all([
    prisma.service.findMany({ include: { apiEndpoints: { select: { id: true, method: true, endpoint: true, status: true, p95Ms: true, availability: true } } } }),
    prisma.serviceDependency.findMany(),
    prisma.incident.findMany({ where: { status: { in: ACTIVE_STATUSES } }, include: { services: true } }),
  ])
  const edges = dependencies.map((row) => ({ from: row.fromServiceId, to: row.toServiceId }))
  const degraded = services.filter((service) => service.status === 'DEGRADED' || service.status === 'INCIDENT')
  const impactedBy = new Map<string, string[]>()
  for (const service of degraded) {
    for (const id of transitiveDependents(service.id, edges)) impactedBy.set(id, [...(impactedBy.get(id) ?? []), service.name])
  }
  return {
    title: 'FinOpsX Demo Service Architecture',
    note: 'Fictional service topology used by the demo simulator. Arrows point from a caller to the service it depends on.',
    layers: ['EDGE', 'CORE', 'INTEGRATION', 'DATA'],
    nodes: services.map((service) => ({
      id: service.id,
      key: service.key,
      name: service.name,
      layer: service.layer ?? 'CORE',
      description: service.description,
      status: service.status,
      responseTimeMs: service.responseTimeMs,
      errorRate: service.errorRate,
      uptime: service.uptime,
      endpoints: service.apiEndpoints.map((endpoint) => ({ id: endpoint.id, key: `${endpoint.method} ${endpoint.endpoint}`, status: endpoint.status, p95Ms: endpoint.p95Ms, availability: endpoint.availability })),
      impactedBy: impactedBy.get(service.id) ?? [],
      activeIncidents: incidents.filter((incident) => incident.services.some((link) => link.serviceId === service.id)).map((incident) => ({ id: incident.publicId, title: incident.title, severity: incident.severity })),
      dependsOn: edges.filter((edge) => edge.from === service.id).map((edge) => edge.to),
      dependents: edges.filter((edge) => edge.to === service.id).map((edge) => edge.from),
    })),
    edges: edges.map((edge) => {
      const target = services.find((service) => service.id === edge.to)
      return { ...edge, degraded: target ? target.status !== 'OPERATIONAL' : false }
    }),
  }
}
