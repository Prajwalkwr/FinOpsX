import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Download, FileText } from 'lucide-react'
import { ANOMALY_LABEL, can, DEMO_LABELS, formatNpr, PAYMENT_LABEL, REPORT_LABEL, REPORT_TYPES, type AnomalyType, type PaymentMethod, type ReportType } from '@finopsx/shared'
import { api, download, errorMessage, idem } from '../api'
import { useAuth, useToast } from '../contexts'
import { axisTick, gridStroke, PALETTE, tooltipStyle } from '../lib/chart'
import { chartTick, fmtDate, fmtDateTime, fmtMs, fmtPct, humanize, queryString, useUrlFilters } from '../lib/format'
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, inputClass, PageHeader, Pagination, Select, Skeleton, Stat, StatusBadge, Table } from '../components/ui'

const DESCRIPTION: Record<ReportType, string> = {
  DAILY_OPERATIONS: 'KPIs, volume, institutions, incidents, anomalies, system health and reconciliation.',
  TRANSACTION_SUMMARY: 'Volume, outcomes, payment methods and failure reasons.',
  INSTITUTION_PERFORMANCE: 'Success, failure and latency per institution.',
  INCIDENT_REPORT: 'Incidents, durations, MTTR and likely or confirmed root causes.',
  ANOMALY_REPORT: 'Operational anomalies with normal vs observed values.',
  SYSTEM_HEALTH: 'Service status, API error rates and P95 latency.',
  RECONCILIATION_REPORT: 'Reconciliation runs and settlement batches.',
}

type ReportRow = { id: string; type: ReportType; title: string; dateFrom: string; dateTo: string; deliveryStatus: string; createdAt: string; createdBy: string }

async function downloadReport(id: string, format: 'pdf' | 'csv' | 'xlsx', toast: ReturnType<typeof useToast>) {
  try {
    await download(`/api/reports/${id}/download?format=${format}`)
    toast.push(`Downloaded ${format.toUpperCase()}`)
  } catch (error) { toast.push(errorMessage(error), 'err') }
}

export function ReportsPage() {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [filters, setFilters] = useUrlFilters({ type: '', page: '1' })
  const [type, setType] = useState<ReportType>('DAILY_OPERATIONS')
  const [range, setRange] = useState('today')
  const [busy, setBusy] = useState(false)
  const [remove, setRemove] = useState<string | null>(null)
  const params = queryString({ type: filters.type, page: filters.page, limit: 20 })
  const query = useQuery({ queryKey: ['reports', params], queryFn: () => api<{ items: ReportRow[]; page: number; totalPages: number }>(`/api/reports?${params}`), placeholderData: (previous) => previous })
  const schedules = useQuery({ queryKey: ['reports', 'schedules'], queryFn: () => api<Array<{ id: string; cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY'; enabled: boolean; reportType: string; lastRunAt: string | null; nextRunAt: string | null; email: string }>>('/api/reports/schedules') })
  const canGenerate = Boolean(user && can(user.role, 'reports:generate'))
  const canDelete = Boolean(user && can(user.role, 'reports:delete'))
  const canSchedule = Boolean(user && can(user.role, 'settings:security'))

  async function generate() {
    setBusy(true)
    try {
      const report = await api<{ id: string }>('/api/reports', { method: 'POST', headers: idem('report'), body: JSON.stringify({ type, range }) })
      toast.push('Report generated')
      client.invalidateQueries({ queryKey: ['reports'] })
      navigate(`/reports/${report.id}`)
    } catch (error) { toast.push(errorMessage(error), 'err') } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Reports" description="Reports are snapshots built from the same aggregates as the dashboard. Each can be viewed in the browser or downloaded as PDF, CSV or Excel." />
      {canGenerate ? (
        <Card title="Generate a report">
          <div className="grid gap-3 md:grid-cols-[1fr_200px_auto] md:items-end">
            <Field label="Report type"><select className={inputClass} value={type} onChange={(event) => setType(event.target.value as ReportType)}>{REPORT_TYPES.map((item) => <option key={item} value={item}>{REPORT_LABEL[item]}</option>)}</select></Field>
            <Field label="Period"><select className={inputClass} value={range} onChange={(event) => setRange(event.target.value)}>{[['today', 'Today'], ['yesterday', 'Yesterday'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
            <Button disabled={busy} onClick={generate}>{busy ? 'Generating…' : 'Generate'}</Button>
          </div>
          <p className="mt-2 text-xs text-muted">{DESCRIPTION[type]}</p>
        </Card>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Select label="Type" value={filters.type} onChange={(value) => setFilters({ type: value })} options={[['', 'All report types'], ...REPORT_TYPES.map((item) => [item, REPORT_LABEL[item]] as [string, string])]} />
      </div>
      {query.isLoading ? <Skeleton className="h-48" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.items.length ? (
        <>
          <div className="grid gap-3">
            {query.data.items.map((report) => (
              <article key={report.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-card p-4 shadow-card">
                <div className="flex min-w-0 items-start gap-3">
                  <FileText className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
                  <div className="min-w-0">
                    <Link to={`/reports/${report.id}`} className="font-medium text-brand">{report.title}</Link>
                    <p className="text-xs text-muted">{REPORT_LABEL[report.type] ?? humanize(report.type)} · {fmtDateTime(report.createdAt)} · by {report.createdBy} · {report.deliveryStatus === 'SENT' ? 'emailed' : 'email not sent (SMTP not configured)'}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link to={`/reports/${report.id}`} className="rounded-full border border-line px-3 py-1.5 text-sm">View</Link>
                  {(['pdf', 'csv', 'xlsx'] as const).map((format) => <Button key={format} variant="ghost" onClick={() => downloadReport(report.id, format, toast)}>{format.toUpperCase()}</Button>)}
                  {canDelete ? <Button variant="danger" onClick={() => setRemove(report.id)}>Delete</Button> : null}
                </div>
              </article>
            ))}
          </div>
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={(page) => setFilters({ page: String(page) })} />
        </>
      ) : filters.type
        ? <EmptyState title={`No ${REPORT_LABEL[filters.type as ReportType] ?? humanize(filters.type)}s yet.`} detail={canGenerate ? 'Generate one above or choose another type.' : 'Choose another report type.'} />
        : <EmptyState title="No reports yet." detail={canGenerate ? 'Generate one above.' : undefined} />}
      <Card title="Scheduled reports">
        <p className="mb-3 text-xs text-muted">Schedules generate a Daily Operations report automatically. {schedules.data?.[0]?.email ?? 'Email delivery is only available when SMTP is configured.'}</p>
        {schedules.data?.length ? (
          <Table head={['Cadence', 'Enabled', 'Report', 'Last run', 'Next run']} minWidth={520}>
            {schedules.data.map((schedule) => (
              <tr key={schedule.cadence}>
                <td>{humanize(schedule.cadence)}</td>
                <td>
                  <input type="checkbox" aria-label={`${schedule.cadence} schedule enabled`} disabled={!canSchedule} checked={schedule.enabled} onChange={async (event) => {
                    try {
                      await api(`/api/reports/schedules/${schedule.cadence}`, { method: 'PUT', body: JSON.stringify({ enabled: event.target.checked }) })
                      schedules.refetch()
                      toast.push('Schedule saved')
                    } catch (error) { toast.push(errorMessage(error), 'err') }
                  }} />
                </td>
                <td>{REPORT_LABEL[schedule.reportType as ReportType] ?? humanize(schedule.reportType)}</td>
                <td className="text-muted">{fmtDateTime(schedule.lastRunAt)}</td>
                <td className="text-muted">{schedule.enabled ? fmtDateTime(schedule.nextRunAt) : '—'}</td>
              </tr>
            ))}
          </Table>
        ) : <p className="text-sm text-muted">No schedules configured.</p>}
      </Card>
      {remove ? <ConfirmDialog title="Delete report" body="Delete this generated report? This is audited and cannot be undone." confirmLabel="Delete" danger onClose={() => setRemove(null)} onConfirm={async () => {
        try {
          await api(`/api/reports/${remove}`, { method: 'DELETE' })
          toast.push('Report deleted')
          client.invalidateQueries({ queryKey: ['reports'] })
        } catch (error) { toast.push(errorMessage(error), 'err') } finally { setRemove(null) }
      }} /> : null}
    </div>
  )
}

type Payload = {
  type: ReportType
  sections: string[]
  from: string
  to: string
  generatedAt: string
  synthetic: boolean
  kpis: { total: number; successful: number; failed: number; pending: number; reversed: number; settled: number; successRate: number; failureRate: number; value: number; avgLatencyMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; incidents: number; criticalIncidents: number; mttrMinutes: number | null; anomalies: number; apiAvailability: number | null }
  volume: Array<{ time: string; success: number; failed: number; pending: number; other: number }>
  outcomes: Array<{ name: string; value: number }>
  paymentMethods: Array<{ method: string; count: number; value: number }>
  failureReasons: Array<{ reason: string; count: number }>
  institutions: Array<{ name: string; code: string; transactions: number; successRate: number; failureRate: number; avgResponseMs: number; value: number }>
  topInstitution: string | null
  highestFailureInstitution: string | null
  incidents: Array<{ id: string; title: string; severity: string; status: string; assignee: string | null; detectedAt: string; resolvedAt: string | null; durationMinutes: number | null; services: string[]; rootCause: string | null; rootCauseConfirmed: boolean }>
  anomalies: Array<{ id: string; type: AnomalyType; severity: string; status: string; title: string; entity: string; normalValue: number; observedValue: number; detectedAt: string }>
  anomalyTypes: Array<{ type: AnomalyType; count: number }>
  systemHealth: Array<{ name: string; status: string; responseTimeMs: number; errorRate: number; uptime: number }>
  apis: Array<{ endpoint: string; calls: number; errorRate: number; p95Ms: number }>
  reconciliation: Array<{ id: string; status: string; windowFrom: string; windowTo: string; expected: number; matched: number; unmatched: number; difference: number; settlementDifference: number }>
  settlements: Array<{ status: string; batches: number; transactions: number; amount: number }>
  aiSummary: string
}

const OUTCOME_COLORS: Record<string, string> = { Successful: '#10b981', Failed: '#ef4444', Pending: '#f59e0b', Reversed: '#64748b' }

export function ReportDetailPage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const query = useQuery({ queryKey: ['report', id], queryFn: () => api<{ id: string; type: ReportType; title: string; dateFrom: string; dateTo: string; payload: Payload; deliveryStatus: string; createdAt: string }>(`/api/reports/${id}`) })
  if (query.isLoading) return <Skeleton className="h-80" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} />
  const report = query.data!
  const p = report.payload
  if (!p?.kpis) return <ErrorState message="This report was generated by an older version. Generate it again to view it." />
  const has = (section: string) => p.sections.includes(section)
  const k = p.kpis
  const span = new Date(p.to).getTime() - new Date(p.from).getTime()
  const unit = span > 3 * 86400_000 ? 'day' : undefined
  return (
    <div className="space-y-4">
      <Link to="/reports" className="text-sm text-brand">← Reports</Link>
      <PageHeader
        title={report.title}
        description={<>{fmtDateTime(p.from)} – {fmtDateTime(p.to)} (Nepal time) · generated {fmtDateTime(p.generatedAt)} · <Badge tone="info">Synthetic data only</Badge></>}
        actions={<div className="flex gap-2">{(['pdf', 'csv', 'xlsx'] as const).map((format) => <Button key={format} variant="ghost" onClick={() => downloadReport(report.id, format, toast)}><Download className="mr-1 inline h-4 w-4" />{format.toUpperCase()}</Button>)}</div>}
      />
      <Card title="Summary">
        <p className="text-sm leading-relaxed">{p.aiSummary}</p>
      </Card>

      {has('kpis') ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Transactions" value={k.total.toLocaleString('en-US')} hint={formatNpr(k.value)} />
          <Stat label="Success rate" value={fmtPct(k.successRate)} tone="good" hint={`${k.successful.toLocaleString('en-US')} successful, ${k.settled.toLocaleString('en-US')} settled`} />
          <Stat label="Failure rate" value={fmtPct(k.failureRate)} tone={k.failureRate >= 10 ? 'bad' : undefined} hint={`${k.failed.toLocaleString('en-US')} failed · ${k.pending} pending`} />
          <Stat label="Latency P50 / P95 / P99" value={<span className="text-base">{fmtMs(k.p50Ms)} / {fmtMs(k.p95Ms)} / {fmtMs(k.p99Ms)}</span>} hint={`API availability ${k.apiAvailability == null ? 'n/a' : fmtPct(k.apiAvailability, 2)}`} />
        </div>
      ) : null}
      {has('incidentKpis') ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Incidents" value={k.incidents} />
          <Stat label="High / critical" value={k.criticalIncidents} tone={k.criticalIncidents ? 'bad' : undefined} />
          <Stat label="Mean time to resolve" value={k.mttrMinutes == null ? 'n/a' : `${k.mttrMinutes.toFixed(0)} min`} />
        </div>
      ) : null}
      {has('anomalyKpis') ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Anomalies" value={k.anomalies} />
          <Stat label="Types seen" value={p.anomalyTypes.length} />
          <Stat label="Confirmed" value={p.anomalies.filter((row) => row.status === 'CONFIRMED').length} />
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.4fr_.6fr]">
        {has('volume') ? (
          <Card title="Volume by outcome">
            {p.volume.length ? (
              <div className="h-60">
                <ResponsiveContainer>
                  <AreaChart data={p.volume}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                    <XAxis dataKey="time" tickFormatter={(value) => chartTick(value, unit)} tick={axisTick} minTickGap={40} />
                    <YAxis tick={axisTick} width={44} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => fmtDateTime(String(value))} />
                    <Area type="monotone" stackId="1" dataKey="success" name="Successful" stroke="#10b981" fill="#10b981" fillOpacity={0.35} />
                    <Area type="monotone" stackId="1" dataKey="pending" name="Pending" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.35} />
                    <Area type="monotone" stackId="1" dataKey="failed" name="Failed" stroke="#ef4444" fill="#ef4444" fillOpacity={0.35} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : <EmptyState title="No transactions in this window." />}
          </Card>
        ) : null}
        {has('outcomes') ? (
          <Card title="Outcomes">
            <div className="h-60">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={p.outcomes.filter((row) => row.value > 0)} dataKey="value" nameKey="name" innerRadius={50} outerRadius={85}>
                    {p.outcomes.filter((row) => row.value > 0).map((row) => <Cell key={row.name} fill={OUTCOME_COLORS[row.name] ?? '#64748b'} />)}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(value) => Number(value).toLocaleString('en-US')} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="mt-2 grid grid-cols-2 gap-1 text-xs">{p.outcomes.map((row) => <li key={row.name}><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: OUTCOME_COLORS[row.name] }} />{row.name}: {row.value.toLocaleString('en-US')}</li>)}</ul>
          </Card>
        ) : null}
      </div>

      {has('paymentMethods') ? (
        <Card title="Payment methods">
          <div className="h-56">
            <ResponsiveContainer>
              <BarChart data={p.paymentMethods.map((row) => ({ ...row, label: PAYMENT_LABEL[row.method as PaymentMethod] ?? row.method }))}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                <XAxis dataKey="label" tick={axisTick} />
                <YAxis tick={axisTick} width={44} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="count" name="Transactions" radius={[6, 6, 0, 0]}>{p.paymentMethods.map((row, index) => <Cell key={row.method} fill={PALETTE[index % PALETTE.length]} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ) : null}

      {has('failureReasons') ? (
        <Card title="Failure reasons">
          {p.failureReasons.length ? (
            <div className="h-56">
              <ResponsiveContainer>
                <BarChart data={p.failureReasons.map((row) => ({ ...row, label: humanize(row.reason) }))} layout="vertical" margin={{ left: 20 }}>
                  <XAxis type="number" tick={axisTick} />
                  <YAxis type="category" dataKey="label" tick={axisTick} width={150} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name="Failures" fill="#ef4444" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <p className="text-sm text-muted">No failures in this window.</p>}
        </Card>
      ) : null}

      {has('institutions') ? (
        <Card title="Institution performance">
          <p className="mb-2 text-xs text-muted">Best success rate: {p.topInstitution ?? 'n/a'} · Highest failure rate: {p.highestFailureInstitution ?? 'n/a'} (institutions with at least 20 transactions)</p>
          <Table head={['Institution', 'Transactions', 'Success', 'Failure', 'Avg response', 'Value']} minWidth={640}>
            {p.institutions.map((row) => (
              <tr key={row.code}><td>{row.name}</td><td className="tabular-nums">{row.transactions.toLocaleString('en-US')}</td><td className="tabular-nums">{fmtPct(row.successRate)}</td><td className="tabular-nums">{fmtPct(row.failureRate)}</td><td className="tabular-nums">{fmtMs(row.avgResponseMs)}</td><td className="tabular-nums">{formatNpr(row.value)}</td></tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {has('incidents') ? (
        <Card title="Incidents">
          {p.incidents.length ? (
            <Table head={['Incident', 'Severity', 'Status', 'Title', 'Detected', 'Duration', 'Root cause']} minWidth={900}>
              {p.incidents.map((row) => (
                <tr key={row.id}>
                  <td><Link className="text-brand" to={`/incidents/${row.id}`}>{row.id}</Link></td>
                  <td><StatusBadge status={row.severity} /></td>
                  <td><StatusBadge status={row.status} /></td>
                  <td>{row.title}</td>
                  <td className="text-muted">{fmtDateTime(row.detectedAt)}</td>
                  <td className="tabular-nums">{row.durationMinutes == null ? 'open' : `${row.durationMinutes} min`}</td>
                  <td className="text-xs">{row.rootCause ? <><Badge tone={row.rootCauseConfirmed ? 'good' : 'warn'}>{row.rootCauseConfirmed ? 'Confirmed' : 'Likely'}</Badge> {row.rootCause}</> : '—'}</td>
                </tr>
              ))}
            </Table>
          ) : <p className="text-sm text-muted">No incidents in this window.</p>}
        </Card>
      ) : null}

      {has('anomalyTypes') && p.anomalyTypes.length ? (
        <Card title="Anomalies by type">
          <div className="h-48">
            <ResponsiveContainer>
              <BarChart data={p.anomalyTypes.map((row) => ({ ...row, label: ANOMALY_LABEL[row.type] ?? row.type }))}>
                <XAxis dataKey="label" tick={axisTick} interval={0} angle={-15} height={50} textAnchor="end" />
                <YAxis tick={axisTick} width={32} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="count" name="Anomalies" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      ) : null}

      {has('anomalies') ? (
        <Card title="Operational anomalies">
          {p.anomalies.length ? (
            <Table head={['Anomaly', 'Type', 'Entity', 'Normal', 'Observed', 'Severity', 'Status', 'Detected']} minWidth={900}>
              {p.anomalies.map((row) => (
                <tr key={row.id}>
                  <td><Link className="text-brand" to={`/anomalies?focus=${row.id}`}>{row.id}</Link></td>
                  <td>{ANOMALY_LABEL[row.type] ?? humanize(row.type)}</td>
                  <td className="text-muted">{row.entity}</td>
                  <td className="tabular-nums">{Number(row.normalValue.toFixed(2)).toLocaleString('en-US')}</td>
                  <td className="tabular-nums font-medium">{Number(row.observedValue.toFixed(2)).toLocaleString('en-US')}</td>
                  <td><StatusBadge status={row.severity} /></td>
                  <td><StatusBadge status={row.status} /></td>
                  <td className="text-muted">{fmtDateTime(row.detectedAt)}</td>
                </tr>
              ))}
            </Table>
          ) : <p className="text-sm text-muted">No anomalies in this window.</p>}
        </Card>
      ) : null}

      {has('systemHealth') ? (
        <Card title="System health (at generation time)">
          <Table head={['Service', 'Status', 'Response', 'Error rate', 'Availability']} minWidth={560}>
            {p.systemHealth.map((row) => (
              <tr key={row.name}><td>{row.name}</td><td><StatusBadge status={row.status} /></td><td className="tabular-nums">{fmtMs(row.responseTimeMs)}</td><td className="tabular-nums">{fmtPct(row.errorRate)}</td><td className="tabular-nums">{fmtPct(row.uptime, 2)}</td></tr>
            ))}
          </Table>
        </Card>
      ) : null}

      {has('apis') ? (
        <Card title="API endpoints">
          {p.apis.length ? (
            <Table head={['Endpoint', 'Calls', 'Error rate', 'P95']} minWidth={480}>
              {p.apis.map((row) => <tr key={row.endpoint}><td className="font-mono text-xs">{row.endpoint}</td><td className="tabular-nums">{row.calls.toLocaleString('en-US')}</td><td className="tabular-nums">{fmtPct(row.errorRate)}</td><td className="tabular-nums">{fmtMs(row.p95Ms)}</td></tr>)}
            </Table>
          ) : <p className="text-sm text-muted">No API call data in this window (call records are kept for 6 hours).</p>}
        </Card>
      ) : null}

      {has('reconciliation') ? (
        <Card title="Reconciliation runs">
          {p.reconciliation.length ? (
            <Table head={['Run', 'Status', 'Window', 'Expected', 'Matched', 'Unmatched', 'Ledger difference', 'Unsettled value']} minWidth={900}>
              {p.reconciliation.map((row) => (
                <tr key={row.id}>
                  <td><Link className="text-brand" to={`/reconciliation?run=${row.id}`}>{row.id}</Link></td>
                  <td><StatusBadge status={row.status} /></td>
                  <td className="text-xs text-muted">{fmtDate(row.windowFrom)} – {fmtDate(row.windowTo)}</td>
                  <td className="tabular-nums">{row.expected}</td>
                  <td className="tabular-nums">{row.matched}</td>
                  <td className="tabular-nums">{row.unmatched}</td>
                  <td className="tabular-nums">{formatNpr(row.difference)}</td>
                  <td className="tabular-nums">{formatNpr(row.settlementDifference)}</td>
                </tr>
              ))}
            </Table>
          ) : <p className="text-sm text-muted">No reconciliation runs in this window.</p>}
        </Card>
      ) : null}

      {has('settlements') ? (
        <Card title="Settlement batches">
          {p.settlements.length ? (
            <Table head={['Status', 'Batches', 'Transactions', 'Amount']} minWidth={420}>
              {p.settlements.map((row) => <tr key={row.status}><td><StatusBadge status={row.status} /></td><td className="tabular-nums">{row.batches}</td><td className="tabular-nums">{row.transactions.toLocaleString('en-US')}</td><td className="tabular-nums">{formatNpr(row.amount)}</td></tr>)}
            </Table>
          ) : <p className="text-sm text-muted">No settlement batches in this window.</p>}
        </Card>
      ) : null}

      <p className="text-center text-xs text-muted">{DEMO_LABELS.environment} · {DEMO_LABELS.synthetic} · {DEMO_LABELS.disclaimer}</p>
    </div>
  )
}
