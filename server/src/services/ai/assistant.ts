import { Prisma } from '@prisma/client'
import { formatDuration, formatNpr, formatPercent } from '@finopsx/shared'
import { env } from '../../config/env.js'
import { prisma, num } from '../../lib/prisma.js'
import { resolveRange } from '../../utils/range.js'
import { institutionPerformance, transactionAggregates } from '../metricsService.js'
import { systemHealth } from '../healthService.js'
import { inspectQuestion, type ToolName } from './routeQuestion.js'

export type ToolResult = {
  tool: ToolName
  summary: string
  evidence: string[]
  metrics: Record<string, string | number>
  explanation: string
  nextSteps: string[]
  limitation: string
  table?: { columns: string[]; rows: string[][] }
  reportId?: string
}

function limitation(provider: 'mock' | 'openai') {
  const prefix = provider === 'mock' ? 'AI provider unavailable. Using local demo analysis. ' : ''
  return `${prefix}AI-generated analysis — verify before taking operational action. This is based on synthetic demo data.`
}

async function institutionBlock(range = resolveRange({ range: '24h' })) {
  const rows = await institutionPerformance(range)
  const ranked = [...rows].sort((a, b) => b.failureRate - a.failureRate)
  const slowest = [...rows].sort((a, b) => b.avgResponseMs - a.avgResponseMs)[0]
  const worst = ranked[0]
  const best = [...rows].sort((a, b) => b.successRate - a.successRate)[0]
  return { rows, worst, slowest, best, range }
}

export async function runTool(tool: ToolName, question: string, userId?: string): Promise<ToolResult> {
  const range = resolveRange({ range: question.toLowerCase().includes('today') ? 'today' : '24h' })
  if (tool === 'getDashboardMetrics' || tool === 'getTransactionMetrics') {
    const metrics = await transactionAggregates(range)
    return {
      tool,
      summary: `The selected window has ${metrics.total.toLocaleString('en-US')} synthetic transactions with a ${formatPercent(metrics.successRate)} success rate.`,
      evidence: [
        `${metrics.counts.FAILED.toLocaleString('en-US')} failed and ${metrics.counts.PENDING.toLocaleString('en-US')} are pending.`,
        `Average latency is ${formatDuration(metrics.avgLatencyMs)}.`,
      ],
      metrics: {
        total: metrics.total,
        successRate: formatPercent(metrics.successRate),
        value: formatNpr(metrics.value),
        p95: formatDuration(metrics.p95Ms),
      },
      explanation: 'These figures are aggregated from stored transactions for the selected window.',
      nextSteps: ['Open the dashboard range control to compare yesterday.', 'Review institutions if the failure rate is elevated.'],
      limitation: limitation('mock'),
    }
  }
  if (tool === 'getInstitutionMetrics') {
    const data = await institutionBlock(range)
    return {
      tool,
      summary: data.worst
        ? `${data.worst.name} has the highest failure rate at ${formatPercent(data.worst.failureRate)}.`
        : 'No institution activity was found in this window.',
      evidence: data.rows.slice(0, 5).map((row) => `${row.name}: ${formatPercent(row.failureRate)} failure, ${formatDuration(row.avgResponseMs)} average response.`),
      metrics: {
        highestFailure: data.worst?.name ?? 'n/a',
        failureRate: data.worst ? formatPercent(data.worst.failureRate) : 'n/a',
        slowest: data.slowest?.name ?? 'n/a',
        best: data.best?.name ?? 'n/a',
      },
      explanation: 'Failure rate is failed transactions divided by all transactions for each fictional demo institution.',
      nextSteps: ['Open the institution detail page for the highest failure rate.', 'Compare latency before treating the rate as an incident.'],
      limitation: limitation('mock'),
      table: {
        columns: ['Institution', 'Transactions', 'Failure rate', 'Latency'],
        rows: data.rows.map((row) => [row.name, String(row.transactions), formatPercent(row.failureRate), formatDuration(row.avgResponseMs)]),
      },
    }
  }
  if (tool === 'getHourlyVolume') {
    const rows = await prisma.$queryRaw<Array<{ hour: Date; count: number }>>(Prisma.sql`
      SELECT date_trunc('hour', "createdAt") AS hour, COUNT(*)::int AS count
      FROM "Transaction"
      WHERE "createdAt" >= ${range.from} AND "createdAt" <= ${range.to}
      GROUP BY 1 ORDER BY count DESC LIMIT 5
    `)
    const top = rows[0]
    const label = top ? new Date(top.hour).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', hour: '2-digit', minute: '2-digit', hour12: false, day: '2-digit', month: 'short' }) : 'n/a'
    return {
      tool,
      summary: top ? `The busiest hour in this window was ${label} (Asia/Kathmandu) with ${top.count.toLocaleString('en-US')} transactions.` : 'No hourly volume is available yet.',
      evidence: rows.map((row) => `${new Date(row.hour).toISOString()} UTC: ${row.count}`),
      metrics: { busiestHour: label, count: top?.count ?? 0 },
      explanation: 'Hours are aggregated in UTC and labeled in Asia/Kathmandu.',
      nextSteps: ['Check whether that hour overlaps a known incident.'],
      limitation: limitation('mock'),
    }
  }
  if (tool === 'getAnomalies') {
    const rows = await prisma.anomaly.findMany({ orderBy: { detectedAt: 'desc' }, take: 6, include: { institution: true, merchant: true } })
    return {
      tool,
      summary: rows.length ? `${rows.length} recent simulated anomalies are available for review.` : 'No anomalies are open.',
      evidence: rows.map((row) => `${row.type}: ${row.title} (${row.institution?.name ?? row.merchant?.name ?? 'platform'})`),
      metrics: { count: rows.length },
      explanation: 'Detection uses rules, a moving window, z-scores, and a lightweight isolation-style score. It is not a production fraud engine.',
      nextSteps: ['Review each anomaly and confirm or dismiss it.'],
      limitation: limitation('mock'),
      table: {
        columns: ['ID', 'Type', 'Severity', 'Status'],
        rows: rows.map((row) => [row.publicId, row.type, row.severity, row.status]),
      },
    }
  }
  if (tool === 'getIncidents') {
    const rows = await prisma.incident.findMany({ orderBy: { createdAt: 'desc' }, take: 6, include: { services: { include: { service: true } } } })
    const critical = rows.find((row) => row.severity === 'CRITICAL') ?? rows[0]
    return {
      tool,
      summary: critical ? `Latest notable incident: ${critical.publicId} ${critical.title} (${critical.status}).` : 'No incidents are stored.',
      evidence: [critical?.aiSummary ?? 'No AI summary stored.', ...rows.map((row) => `${row.publicId} ${row.severity} ${row.status}`)],
      metrics: { open: rows.filter((row) => !['RESOLVED', 'CLOSED'].includes(row.status)).length },
      explanation: critical?.aiSummary ? 'The stored summary was generated when the incident was opened and should be verified.' : 'No summary is available.',
      nextSteps: ['Open the incident timeline before changing status.'],
      limitation: limitation('mock'),
    }
  }
  if (tool === 'getSystemHealth' || tool === 'getApiMetrics') {
    const health = await systemHealth()
    const slowest = [...health.apis].sort((a, b) => b.latencyMs - a.latencyMs)[0]
    return {
      tool,
      summary: slowest ? `${slowest.method} ${slowest.endpoint} is the slowest API at ${formatDuration(slowest.latencyMs)} with a ${formatPercent(slowest.errorRate)} error rate.` : 'API metrics are not seeded yet.',
      evidence: health.apis.map((api) => `${api.method} ${api.endpoint}: ${formatDuration(api.latencyMs)}, ${formatPercent(api.errorRate)} errors, ${api.rpm}/min`),
      metrics: { slowest: slowest ? `${slowest.method} ${slowest.endpoint}` : 'n/a' },
      explanation: 'Infrastructure figures on the health page are simulated and labeled as such.',
      nextSteps: ['Compare the slow API with the related institution latency chart.'],
      limitation: limitation('mock'),
      table: {
        columns: ['Method', 'Endpoint', 'Latency', 'Error rate'],
        rows: health.apis.map((api) => [api.method, api.endpoint, formatDuration(api.latencyMs), formatPercent(api.errorRate)]),
      },
    }
  }
  if (tool === 'getFailureReasons') {
    const rows = await prisma.transaction.groupBy({
      by: ['failureReason', 'paymentMethod'],
      where: { status: 'FAILED', createdAt: { gte: range.from, lte: range.to }, failureReason: { not: null } },
      _count: { _all: true },
    })
    const byMethod = new Map<string, { failed: number }>()
    const totals = await prisma.transaction.groupBy({
      by: ['paymentMethod', 'status'],
      where: { createdAt: { gte: range.from, lte: range.to } },
      _count: { _all: true },
    })
    for (const row of totals) {
      const entry = byMethod.get(row.paymentMethod) ?? { failed: 0, total: 0 }
      if (row.status === 'FAILED') entry.failed += row._count._all
      byMethod.set(row.paymentMethod, entry)
    }
    const methodRates = [...byMethod.entries()].map(([method, value]) => {
      const total = totals.filter((row) => row.paymentMethod === method).reduce((sum, row) => sum + row._count._all, 0)
      return { method, rate: total ? (value.failed / total) * 100 : 0, failed: value.failed }
    }).sort((a, b) => b.rate - a.rate)
    const reasons = new Map<string, number>()
    for (const row of rows) reasons.set(row.failureReason ?? 'UNKNOWN', (reasons.get(row.failureReason ?? 'UNKNOWN') ?? 0) + row._count._all)
    const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]
    return {
      tool,
      summary: methodRates[0]
        ? `${methodRates[0].method} has the highest failure rate at ${formatPercent(methodRates[0].rate)}.`
        : 'No failed payments were found.',
      evidence: [
        topReason ? `Top failure reason: ${topReason[0]} (${topReason[1]})` : 'No failure reasons recorded.',
        ...methodRates.map((row) => `${row.method}: ${formatPercent(row.rate)}`),
      ],
      metrics: { method: methodRates[0]?.method ?? 'n/a', reason: topReason?.[0] ?? 'n/a' },
      explanation: 'Rates use failed count divided by all transactions for that payment method.',
      nextSteps: ['Filter the transaction list by the top failure reason.'],
      limitation: limitation('mock'),
    }
  }
  if (tool === 'searchTransactions') {
    const parsed = inspectQuestion(question)
    const minAmount = parsed.minAmount ?? 100000
    const rows = await prisma.transaction.findMany({
      where: { amount: { gte: minAmount } },
      orderBy: { amount: 'desc' },
      take: 8,
      include: { institution: true, merchant: true },
    })
    return {
      tool,
      summary: `Found ${rows.length} transactions at or above ${formatNpr(minAmount)} in the current result page.`,
      evidence: rows.map((row) => `${row.transactionId} ${formatNpr(num(row.amount))} ${row.status}`),
      metrics: { minAmount, returned: rows.length },
      explanation: 'The search tool applies an amount filter on the server. It does not accept raw SQL.',
      nextSteps: ['Open a transaction to see its timeline.'],
      limitation: limitation('mock'),
      table: {
        columns: ['Transaction', 'Amount', 'Status', 'Institution'],
        rows: rows.map((row) => [row.transactionId, formatNpr(num(row.amount)), row.status, row.institution.name]),
      },
    }
  }
  if (tool === 'explainFailures') {
    const metrics = await transactionAggregates(range)
    const data = await institutionBlock(range)
    const incidents = await prisma.incident.findMany({ where: { createdAt: { gte: range.from } }, orderBy: { createdAt: 'desc' }, take: 3 })
    return {
      tool,
      summary: `Failure rate for this window is ${formatPercent(metrics.failureRate)}.${data.worst ? ` The largest concentration is ${data.worst.name}.` : ''}`,
      evidence: [
        `${metrics.counts.FAILED.toLocaleString('en-US')} failed transactions.`,
        data.worst ? `${data.worst.name} failure rate ${formatPercent(data.worst.failureRate)} and latency ${formatDuration(data.worst.avgResponseMs)}.` : 'No institution split available.',
        incidents[0] ? `Related incident ${incidents[0].publicId}: ${incidents[0].title}.` : 'No incident was opened in this window.',
      ],
      metrics: { failureRate: formatPercent(metrics.failureRate), institution: data.worst?.name ?? 'n/a' },
      explanation: 'Higher failure counts appear alongside the institution with the weakest success rate. That relationship is a correlation in the demo data, not proof of cause.',
      nextSteps: ['Review the bank API latency.', 'Check timeout responses.', 'Read the related incident timeline.'],
      limitation: limitation('mock'),
    }
  }
  const report = await import('../reportService.js').then((mod) => mod.generateReport({
    type: 'DAILY_OPERATIONS',
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    userId,
    source: 'ai',
  }))
  return {
    tool: 'generateDailyReport',
    summary: `Created ${report.title}.`,
    evidence: [`Report id ${report.id}`, `Delivery: ${report.deliveryStatus}`],
    metrics: { reportId: report.id },
    explanation: 'The report snapshot was built from current database aggregates.',
    nextSteps: ['Download the PDF or CSV from the reports page.'],
    limitation: limitation('mock'),
    reportId: report.id,
  }
}

export async function answerQuestion(question: string, userId?: string, provider: 'mock' | 'openai' = 'mock') {
  const routed = inspectQuestion(question)
  if (routed.refusal) {
    return {
      provider,
      notice: provider === 'mock' ? 'AI provider unavailable. Using local demo analysis.' : undefined,
      content: routed.refusal,
      tool: null as string | null,
      table: null,
      reportId: null as string | null,
    }
  }
  const result = await runTool(routed.tool, question, userId)
  if (provider === 'openai' && env.aiEnabled) {
    try {
      const rewritten = await rewriteWithProvider(question, result)
      return {
        provider: 'openai' as const,
        content: rewritten,
        tool: result.tool,
        table: result.table ?? null,
        reportId: result.reportId ?? null,
      }
    } catch {
      // Fall through to the deterministic answer.
    }
  }
  const content = [
    `Summary: ${result.summary}`,
    '',
    'Evidence:',
    ...result.evidence.map((line) => `- ${line}`),
    '',
    'Likely explanation:',
    result.explanation,
    '',
    'Recommended next steps:',
    ...result.nextSteps.map((step, index) => `${index + 1}. ${step}`),
    '',
    `Limitation: ${provider === 'openai' ? limitation('mock') : result.limitation}`,
  ].join('\n')
  return {
    provider: provider === 'openai' ? 'mock' as const : provider,
    notice: 'AI provider unavailable. Using local demo analysis.',
    content,
    tool: result.tool,
    table: result.table ?? null,
    reportId: result.reportId ?? null,
  }
}

async function rewriteWithProvider(question: string, result: ToolResult) {
  const response = await fetch(`${env.aiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.aiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: env.aiModel,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You are the FinOpsX operations assistant. Use only the JSON tool result. Do not invent transactions, do not suggest money movement, and label the answer as synthetic demo analysis that must be verified.',
        },
        { role: 'user', content: JSON.stringify({ question, result }) },
      ],
    }),
  })
  if (!response.ok) throw new Error('AI provider request failed')
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  const text = body.choices?.[0]?.message?.content
  if (!text) throw new Error('Empty AI response')
  return text
}
