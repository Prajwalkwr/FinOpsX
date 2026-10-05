import type { ReportType } from '@prisma/client'
import ExcelJS from 'exceljs'
import { REPORT_LABEL, formatDuration, formatNpr, formatPercent } from '@finopsx/shared'
import { notFound } from '../lib/errors.js'
import { pageOf } from '../lib/http.js'
import { prisma, num } from '../lib/prisma.js'
import { buildSimplePdf } from '../utils/pdf.js'
import { resolveRange } from '../utils/range.js'
import { writeAudit } from './audit.js'
import { sendEmail } from './email.js'
import { institutionPerformance, transactionAggregates } from './metricsService.js'
import { notifyUsers } from './notify.js'
import type { AuthUser } from '../lib/http.js'
import type { Request } from 'express'

export async function buildPayload(type: ReportType, from: Date, to: Date) {
  const range = { from, to, unit: 'hour' as const, label: 'report' }
  const metrics = await transactionAggregates(range)
  const institutions = await institutionPerformance(range)
  const incidents = await prisma.incident.findMany({
    where: { createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { services: { include: { service: true } } },
  })
  const anomalies = await prisma.anomaly.count({ where: { detectedAt: { gte: from, lte: to } } })
  const reasons = await prisma.transaction.groupBy({
    by: ['failureReason'],
    where: { status: 'FAILED', failureReason: { not: null }, createdAt: { gte: from, lte: to } },
    _count: { _all: true },
  })
  reasons.sort((a, b) => b._count._all - a._count._all)
  const best = [...institutions].sort((a, b) => b.successRate - a.successRate)[0]
  const worst = [...institutions].sort((a, b) => b.failureRate - a.failureRate)[0]
  const services = await prisma.service.findMany()
  return {
    type,
    from: from.toISOString(),
    to: to.toISOString(),
    timezone: 'Asia/Kathmandu',
    synthetic: true,
    total: metrics.total,
    successful: metrics.counts.SUCCESS,
    failed: metrics.counts.FAILED,
    pending: metrics.counts.PENDING,
    successRate: metrics.successRate,
    value: metrics.value,
    avgLatencyMs: metrics.avgLatencyMs,
    p95Ms: metrics.p95Ms,
    p99Ms: metrics.p99Ms,
    majorIncidents: incidents.map((incident) => ({
      id: incident.publicId,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      services: incident.services.map((item) => item.service.name),
    })),
    affectedServices: [...new Set(incidents.flatMap((incident) => incident.services.map((item) => item.service.name)))],
    topInstitution: best?.name ?? null,
    highestFailureInstitution: worst?.name ?? null,
    topFailureReason: reasons[0]?.failureReason ?? null,
    anomalyCount: anomalies,
    institutions: institutions.map((item) => ({
      name: item.name,
      transactions: item.transactions,
      successRate: item.successRate,
      failureRate: item.failureRate,
      avgResponseMs: item.avgResponseMs,
      value: item.value,
    })),
    services: services.map((service) => ({
      name: service.name,
      status: service.status,
      uptime: service.uptime,
      responseTimeMs: service.responseTimeMs,
    })),
    aiSummary: `Synthetic ${REPORT_LABEL[type]} for the selected window. Success rate ${formatPercent(metrics.successRate)}. ${worst ? `${worst.name} has the highest failure rate.` : ''} AI-generated analysis — verify before taking operational action.`,
  }
}

export async function generateReport(input: {
  type: ReportType
  from?: string
  to?: string
  userId?: string
  source?: string
  req?: Request
  user?: AuthUser
}) {
  const fallback = resolveRange({ range: 'today' })
  const from = input.from ? new Date(input.from) : fallback.from
  const to = input.to ? new Date(input.to) : fallback.to
  const payload = await buildPayload(input.type, from, to)
  const email = await sendEmail(
    input.user?.email ?? 'demo@finopsx.demo',
    payload.aiSummary.slice(0, 80),
    'Report generated inside FinOpsX.',
  )
  const report = await prisma.report.create({
    data: {
      type: input.type,
      title: `${REPORT_LABEL[input.type]} · ${from.toISOString().slice(0, 10)}`,
      dateFrom: from,
      dateTo: to,
      payload,
      deliveryStatus: email.delivered ? 'SENT' : 'EMAIL_DISABLED',
      createdById: input.userId,
    },
  })
  if (input.user) {
    await writeAudit({
      user: input.user,
      action: 'GENERATED_REPORT',
      resource: 'REPORT',
      resourceId: report.id,
      req: input.req,
      newValue: { type: input.type },
    })
    await notifyUsers({
      userIds: [input.user.id],
      preference: 'notifyReports',
      type: 'REPORT',
      title: 'Report ready',
      message: report.title,
      severity: 'LOW',
      link: '/reports',
    })
  }
  return { ...report, email }
}

export async function listReports(page: number, limit: number) {
  const skip = (page - 1) * limit
  const [total, rows] = await prisma.$transaction([
    prisma.report.count(),
    prisma.report.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit, include: { createdBy: true } }),
  ])
  return pageOf(rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    dateFrom: row.dateFrom.toISOString(),
    dateTo: row.dateTo.toISOString(),
    deliveryStatus: row.deliveryStatus,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy?.email ?? null,
  })), total, page, limit)
}

export async function getReport(id: string) {
  const row = await prisma.report.findUnique({ where: { id } })
  if (!row) throw notFound('Report not found.')
  return row
}

export async function renderReport(id: string, format: 'pdf' | 'csv' | 'xlsx') {
  const row = await getReport(id)
  const payload = row.payload as Awaited<ReturnType<typeof buildPayload>>
  const lines = [
    `Window: ${payload.from} to ${payload.to} (${payload.timezone})`,
    'Synthetic demonstration data.',
    `Total transactions: ${payload.total}`,
    `Successful: ${payload.successful}`,
    `Failed: ${payload.failed}`,
    `Pending: ${payload.pending}`,
    `Success rate: ${formatPercent(payload.successRate)}`,
    `Transaction value: ${formatNpr(payload.value)}`,
    `Average latency: ${formatDuration(payload.avgLatencyMs)}`,
    `P95: ${formatDuration(payload.p95Ms)}`,
    `P99: ${formatDuration(payload.p99Ms)}`,
    `Top institution: ${payload.topInstitution ?? 'n/a'}`,
    `Highest failure institution: ${payload.highestFailureInstitution ?? 'n/a'}`,
    `Top failure reason: ${payload.topFailureReason ?? 'n/a'}`,
    `Anomalies: ${payload.anomalyCount}`,
    `AI summary: ${payload.aiSummary}`,
    'Incidents:',
    ...payload.majorIncidents.map((incident) => `${incident.id} ${incident.severity} ${incident.status} ${incident.title}`),
    'Institutions:',
    ...payload.institutions.map((item) => `${item.name} tx=${item.transactions} success=${formatPercent(item.successRate)} value=${formatNpr(item.value)}`),
  ]
  if (format === 'pdf') {
    return {
      body: buildSimplePdf(row.title, lines),
      type: 'application/pdf',
      filename: `${row.id}.pdf`,
    }
  }
  if (format === 'csv') {
    const csv = ['section,key,value', ...lines.map((line) => `summary,"${line.replace(/"/g, '""')}",`)].join('\n')
    return { body: Buffer.from(csv), type: 'text/csv', filename: `${row.id}.csv` }
  }
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Report')
  sheet.addRow(['FinOpsX synthetic report'])
  sheet.addRow([row.title])
  lines.forEach((line) => sheet.addRow([line]))
  const inst = workbook.addWorksheet('Institutions')
  inst.addRow(['Name', 'Transactions', 'Success rate', 'Failure rate', 'Value'])
  payload.institutions.forEach((item) => inst.addRow([item.name, item.transactions, item.successRate, item.failureRate, item.value]))
  const buffer = await workbook.xlsx.writeBuffer()
  return {
    body: Buffer.from(buffer),
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `${row.id}.xlsx`,
  }
}

export async function deleteReport(id: string, user: AuthUser, req: Request) {
  const row = await getReport(id)
  await prisma.report.delete({ where: { id: row.id } })
  await writeAudit({ user, action: 'DELETED_REPORT', resource: 'REPORT', resourceId: id, req })
}

export async function listSchedules() {
  const rows = await prisma.reportSchedule.findMany({ orderBy: { cadence: 'asc' } })
  return rows.map((row) => ({
    ...row,
    email: 'Email delivery is disabled in demo environment unless SMTP is configured.',
  }))
}

export async function updateSchedule(cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY', enabled: boolean, user: AuthUser, req: Request) {
  const next = enabled ? new Date(Date.now() + 86400_000) : null
  const row = await prisma.reportSchedule.upsert({
    where: { cadence },
    update: { enabled, nextRunAt: next, deliveryStatus: 'EMAIL_DISABLED' },
    create: { cadence, enabled, nextRunAt: next, deliveryStatus: 'EMAIL_DISABLED' },
  })
  await writeAudit({
    user,
    action: 'UPDATED_SETTINGS',
    resource: 'REPORT_SCHEDULE',
    resourceId: cadence,
    req,
    newValue: { enabled },
  })
  return row
}

export async function runDueSchedules() {
  const due = await prisma.reportSchedule.findMany({ where: { enabled: true, nextRunAt: { lte: new Date() } } })
  for (const schedule of due) {
    const range = resolveRange({ range: schedule.cadence === 'DAILY' ? 'today' : schedule.cadence === 'WEEKLY' ? '7d' : '30d' })
    await generateReport({ type: schedule.reportType, from: range.from.toISOString(), to: range.to.toISOString(), source: 'schedule' })
    const next = new Date(Date.now() + (schedule.cadence === 'DAILY' ? 1 : schedule.cadence === 'WEEKLY' ? 7 : 30) * 86400_000)
    await prisma.reportSchedule.update({
      where: { id: schedule.id },
      data: { lastRunAt: new Date(), nextRunAt: next, deliveryStatus: 'SIMULATED_DELIVERY' },
    })
  }
}

let scheduleTimer: NodeJS.Timeout | null = null
export function startReportScheduler() {
  if (scheduleTimer) return
  scheduleTimer = setInterval(() => { runDueSchedules().catch(() => undefined) }, 60_000)
}
