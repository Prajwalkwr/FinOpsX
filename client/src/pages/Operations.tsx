import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ANOMALY_LABEL, ANOMALY_STATUSES, ANOMALY_TYPES, can, formatNpr, SEVERITIES, type AnomalyType } from '@finopsx/shared'
import { api, errorMessage, idem } from '../api'
import { useAuth, useToast } from '../contexts'
import { axisTick, gridStroke, tooltipStyle } from '../lib/chart'
import { chartTick, fmtDateTime, fmtMs, fmtPct, humanize, queryString, relTime, useUrlFilters } from '../lib/format'
import { Badge, Button, Card, Drawer, EmptyState, ErrorState, Field, inputClass, PageHeader, Pagination, Select, Skeleton, Stat, StatusBadge, Table } from '../components/ui'

const RANGES: Array<[string, string]> = [['1h', 'Last hour'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']]

type InstitutionRow = {
  id: string
  name: string
  code: string
  type: string
  status: string
  transactions: number
  successRate: number
  failureRate: number
  failures: number
  avgResponseMs: number
  value: number
  apiAvailability: number | null
  apiCalls: number
  lastIncident: { id: string; title: string; status: string } | null
}

export function InstitutionsPage() {
  const [filters, setFilters] = useUrlFilters({ range: '24h' })
  const query = useQuery({ queryKey: ['institutions', filters.range], queryFn: () => api<InstitutionRow[]>(`/api/institutions?range=${filters.range}`), refetchInterval: 30_000 })
  return (
    <div>
      <PageHeader
        title="Institutions"
        description="Synthetic demo institutions. Status is derived from their transaction outcomes and API latency; the API availability column covers the last hour of calls."
        actions={<Select label="Range" value={filters.range} onChange={(range) => setFilters({ range })} options={RANGES} />}
      />
      {query.isLoading ? <Skeleton className="h-64" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.length ? (
        <Table head={['Institution', 'Type', 'Status', 'Transactions', 'Success', 'Failure', 'Avg response', 'API availability', 'Value', 'Last incident']} minWidth={1050}>
          {query.data.map((row) => (
            <tr key={row.id}>
              <td><Link className="font-medium text-brand" to={`/institutions/${row.code}?range=${filters.range}`}>{row.name}</Link><p className="text-[11px] text-muted">{row.code}</p></td>
              <td className="text-muted">{humanize(row.type)}</td>
              <td><StatusBadge status={row.status} /></td>
              <td className="tabular-nums">{row.transactions.toLocaleString('en-US')}</td>
              <td className="tabular-nums">{row.transactions ? fmtPct(row.successRate) : '—'}</td>
              <td className={`tabular-nums ${row.failureRate >= 10 ? 'text-red-600' : ''}`}>{row.transactions ? fmtPct(row.failureRate) : '—'}</td>
              <td className="tabular-nums">{row.transactions ? fmtMs(row.avgResponseMs) : '—'}</td>
              <td className="tabular-nums">{fmtPct(row.apiAvailability, 2)}</td>
              <td className="tabular-nums">{formatNpr(row.value)}</td>
              <td>{row.lastIncident ? <Link className="text-brand" to={`/incidents/${row.lastIncident.id}`}>{row.lastIncident.id}</Link> : <span className="text-muted">—</span>}</td>
            </tr>
          ))}
        </Table>
      ) : <EmptyState title="No institutions configured." />}
    </div>
  )
}

type InstitutionDetail = InstitutionRow & {
  range: { label: string }
  p95Ms: number | null
  p99Ms: number | null
  pending: number
  reversed: number
  ledgerRecords: number
  topFailure: string | null
  failureReasons: Array<{ reason: string; count: number }>
  volume: Array<{ time: string; success: number; failed: number; pending: number; other: number }>
  incidents: Array<{ id: string; title: string; severity: string; status: string; detectedAt: string }>
}

export function InstitutionDetailPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const [filters, setFilters] = useUrlFilters({ range: '24h' })
  const query = useQuery({ queryKey: ['institution', id, filters.range], queryFn: () => api<InstitutionDetail>(`/api/institutions/${id}?range=${filters.range}`), refetchInterval: 30_000 })
  if (query.isLoading) return <Skeleton className="h-80" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} />
  const row = query.data!
  const canTx = Boolean(user && can(user.role, 'transactions:view'))
  const unit = filters.range === '7d' || filters.range === '30d' ? 'day' : undefined
  return (
    <div className="space-y-4">
      <Link to="/institutions" className="text-sm text-brand">← Institutions</Link>
      <PageHeader
        title={row.name}
        description={<>{row.code} · {humanize(row.type)} · synthetic demo institution · {row.range.label}</>}
        actions={<div className="flex items-center gap-2"><StatusBadge status={row.status} /><Select label="Range" value={filters.range} onChange={(range) => setFilters({ range })} options={RANGES} /></div>}
      />
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Transactions" value={row.transactions.toLocaleString('en-US')} hint={formatNpr(row.value)} />
        <Stat label="Success rate" value={row.transactions ? fmtPct(row.successRate) : '—'} tone="good" />
        <Stat label="Failure rate" value={row.transactions ? fmtPct(row.failureRate) : '—'} tone={row.failureRate >= 10 ? 'bad' : undefined} hint={`${row.failures} failed`} />
        <Stat label="Avg response" value={fmtMs(row.avgResponseMs)} hint={`P95 ${fmtMs(row.p95Ms)} · P99 ${fmtMs(row.p99Ms)}`} />
        <Stat label="Pending" value={row.pending} hint={`${row.reversed} reversed`} />
        <Stat label="Institution records" value={row.ledgerRecords} hint="Ledger entries in range (used by reconciliation)" />
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.4fr_.6fr]">
        <Card title="Volume by outcome">
          {row.volume.length ? (
            <div className="h-60" role="img" aria-label="Transactions by outcome over time">
              <ResponsiveContainer>
                <AreaChart data={row.volume}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                  <XAxis dataKey="time" tickFormatter={(value) => chartTick(value, unit)} tick={axisTick} minTickGap={40} />
                  <YAxis tick={axisTick} width={40} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => fmtDateTime(String(value))} />
                  <Area type="monotone" stackId="1" dataKey="success" name="Successful" stroke="#10b981" fill="#10b981" fillOpacity={0.35} />
                  <Area type="monotone" stackId="1" dataKey="pending" name="Pending" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.35} />
                  <Area type="monotone" stackId="1" dataKey="failed" name="Failed" stroke="#ef4444" fill="#ef4444" fillOpacity={0.35} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState title="No transactions in this range." />}
        </Card>
        <Card title="Failure reasons">
          {row.failureReasons.length ? (
            <ul className="space-y-2 text-sm">
              {row.failureReasons.map((reason) => (
                <li key={reason.reason} className="flex items-center justify-between gap-2">
                  {canTx ? <Link className="text-brand" to={`/transactions?institution=${row.code}&status=FAILED&failureReason=${reason.reason}&range=${filters.range}`}>{humanize(reason.reason)}</Link> : <span>{humanize(reason.reason)}</span>}
                  <span className="tabular-nums text-muted">{reason.count}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">No failures in this range.</p>}
        </Card>
      </div>
      <Card title="Incidents involving this institution">
        {row.incidents.length ? (
          <Table head={['Incident', 'Title', 'Severity', 'Status', 'Detected']} minWidth={560}>
            {row.incidents.map((incident) => (
              <tr key={incident.id}>
                <td><Link className="text-brand" to={`/incidents/${incident.id}`}>{incident.id}</Link></td>
                <td>{incident.title}</td>
                <td><StatusBadge status={incident.severity} /></td>
                <td><StatusBadge status={incident.status} /></td>
                <td className="text-muted">{fmtDateTime(incident.detectedAt)}</td>
              </tr>
            ))}
          </Table>
        ) : <p className="text-sm text-muted">No incidents linked to this institution.</p>}
      </Card>
      {canTx ? <Link className="text-sm text-brand" to={`/transactions?institution=${row.code}&range=${filters.range}`}>View all transactions at {row.name} →</Link> : null}
    </div>
  )
}

type Anomaly = {
  id: string
  publicId: string
  type: AnomalyType
  severity: string
  status: string
  score: number
  title: string
  description: string
  method: string
  entityType: string
  entityName: string
  normalValue: number
  observedValue: number
  detectedAt: string
  reviewedAt: string | null
  resolvedAt: string | null
  decisionNote: string | null
  institution: string | null
  merchant: string | null
  incident: { id: string; title: string; status: string } | null
  evidence: Record<string, unknown> | null
}

function anomalyValue(anomaly: Pick<Anomaly, 'type' | 'evidence'>, value: number) {
  const unit = typeof anomaly.evidence?.unit === 'string' ? anomaly.evidence.unit : anomaly.type === 'HIGH_VALUE_SPIKE' ? 'NPR' : anomaly.type === 'REPEATED_FAILURE' ? 'failures' : ''
  if (unit === 'NPR') return formatNpr(value)
  if (unit === 'ms') return fmtMs(value)
  if (unit.startsWith('%')) return `${value.toFixed(1)}${unit}`
  return `${Number(value.toFixed(2)).toLocaleString('en-US')}${unit ? ` ${unit}` : ''}`
}

const METHOD_LABEL: Record<string, string> = {
  'z-score': 'Z-score against moving baseline',
  'moving-average': 'Moving-average deviation',
  threshold: 'Configured threshold',
  rule: 'Rule',
}

export function AnomaliesPage() {
  const [filters, setFilters] = useUrlFilters({ status: '', type: '', severity: '', q: '', page: '1', focus: '' })
  const params = queryString({ status: filters.status, type: filters.type, severity: filters.severity, q: filters.q, page: filters.page, limit: 25 })
  const query = useQuery({ queryKey: ['anomalies', params], queryFn: () => api<{ items: Anomaly[]; page: number; totalPages: number; total: number }>(`/api/anomalies?${params}`), placeholderData: (previous) => previous })
  return (
    <div>
      <PageHeader
        title="Operational Anomaly Detection"
        description="Statistical detection on synthetic operational metrics: moving-average baselines with z-scores, falling back to configured thresholds while history is short. These are operational signals for review, not fraud decisions."
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select label="Status" value={filters.status} onChange={(status) => setFilters({ status })} options={[['', 'Any status'], ...ANOMALY_STATUSES.map((item) => [item, humanize(item)] as [string, string])]} />
        <Select label="Type" value={filters.type} onChange={(type) => setFilters({ type })} options={[['', 'Any type'], ...ANOMALY_TYPES.map((item) => [item, ANOMALY_LABEL[item]] as [string, string])]} />
        <Select label="Severity" value={filters.severity} onChange={(severity) => setFilters({ severity })} options={[['', 'Any severity'], ...SEVERITIES.map((item) => [item, humanize(item)] as [string, string])]} />
        <input aria-label="Search anomalies" className="rounded-full border border-line bg-card px-3 py-1.5 text-sm" placeholder="ANM-ID, title or entity" value={filters.q} onChange={(event) => setFilters({ q: event.target.value })} />
      </div>
      {query.isLoading ? <Skeleton className="h-64" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.items.length ? (
        <>
          <Table head={['Anomaly', 'Type', 'Entity', 'Normal → observed', 'Score', 'Severity', 'Status', 'Detected']} minWidth={1000}>
            {query.data.items.map((row) => (
              <tr key={row.publicId} className={filters.focus === row.publicId ? 'bg-blue-50/60 dark:bg-blue-950/30' : ''}>
                <td><button className="text-left font-medium text-brand" onClick={() => setFilters({ focus: row.publicId, page: filters.page })}>{row.publicId}</button><p className="max-w-xs truncate text-[11px] text-muted">{row.title}</p></td>
                <td>{ANOMALY_LABEL[row.type] ?? humanize(row.type)}</td>
                <td className="text-muted">{row.entityName}</td>
                <td className="whitespace-nowrap tabular-nums">{anomalyValue(row, row.normalValue)} → <strong>{anomalyValue(row, row.observedValue)}</strong></td>
                <td className="tabular-nums">{(row.score * 100).toFixed(0)}</td>
                <td><StatusBadge status={row.severity} /></td>
                <td><StatusBadge status={row.status} /></td>
                <td className="whitespace-nowrap text-muted">{relTime(row.detectedAt)}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={(page) => setFilters({ page: String(page), focus: filters.focus })} />
        </>
      ) : <EmptyState title="No anomalies match these filters." detail="Run a scenario from the Demo Simulator to trigger detection." />}
      {filters.focus ? <AnomalyDrawer id={filters.focus} onClose={() => setFilters({ focus: '', page: filters.page })} /> : null}
    </div>
  )
}

function AnomalyDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const query = useQuery({ queryKey: ['anomaly', id], queryFn: () => api<Anomaly & { relatedTransactions: Array<{ transactionId: string; status: string; amount: number; institution: string; merchant: string; responseTimeMs: number; failureReason: string | null; createdAt: string }> }>(`/api/anomalies/${id}`) })
  const canReview = Boolean(user && can(user.role, 'anomalies:review'))
  const canTx = Boolean(user && can(user.role, 'transactions:view'))

  async function review(status: 'REVIEW' | 'CONFIRMED' | 'DISMISSED' | 'RESOLVED') {
    setBusy(true)
    try {
      await api(`/api/anomalies/${id}`, { method: 'PATCH', headers: idem(`anm-${id}`), body: JSON.stringify({ status, note: note || undefined }) })
      toast.push(`Marked ${humanize(status).toLowerCase()}`)
      setNote('')
      client.invalidateQueries({ queryKey: ['anomaly', id] })
      client.invalidateQueries({ queryKey: ['anomalies'] })
    } catch (error) { toast.push(errorMessage(error), 'err') } finally { setBusy(false) }
  }

  return (
    <Drawer title={id} onClose={onClose} wide>
      {query.isLoading ? <Skeleton className="h-64" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : (() => {
        const row = query.data!
        const evidence = Object.entries(row.evidence ?? {}).filter(([key]) => key !== 'unit')
        return (
          <div className="space-y-4 text-sm">
            <div>
              <p className="font-semibold">{row.title}</p>
              <div className="mt-1 flex flex-wrap gap-2"><StatusBadge status={row.severity} /><StatusBadge status={row.status} /><Badge tone="info">synthetic data</Badge></div>
              <p className="mt-2 text-muted">{row.description}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Normal (baseline)" value={anomalyValue(row, row.normalValue)} />
              <Stat label="Observed" value={anomalyValue(row, row.observedValue)} tone="warn" />
              <Stat label="Anomaly score" value={(row.score * 100).toFixed(0)} hint="0–100; higher means further from normal" />
              <Stat label="Detection method" value={<span className="text-sm">{METHOD_LABEL[row.method] ?? humanize(row.method)}</span>} />
            </div>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div><dt className="text-muted">Entity</dt><dd>{humanize(row.entityType)} · {row.entityName}</dd></div>
              <div><dt className="text-muted">Detected</dt><dd>{fmtDateTime(row.detectedAt)}</dd></div>
              {row.institution ? <div><dt className="text-muted">Institution</dt><dd>{row.institution}</dd></div> : null}
              {row.merchant ? <div><dt className="text-muted">Merchant</dt><dd>{row.merchant}</dd></div> : null}
              {row.incident ? <div><dt className="text-muted">Linked incident</dt><dd><Link className="text-brand" to={`/incidents/${row.incident.id}`}>{row.incident.id}</Link> <StatusBadge status={row.incident.status} /></dd></div> : null}
              {row.reviewedAt ? <div><dt className="text-muted">Reviewed</dt><dd>{fmtDateTime(row.reviewedAt)}</dd></div> : null}
              {row.decisionNote ? <div className="col-span-2"><dt className="text-muted">Decision note</dt><dd>{row.decisionNote}</dd></div> : null}
            </dl>
            {evidence.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Evidence</p>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-2xl border border-line p-3 text-xs">
                  {evidence.map(([key, value]) => (
                    <div key={key} className="contents"><dt className="text-muted">{humanize(key.replace(/([A-Z])/g, '_$1'))}</dt><dd className="break-words">{Array.isArray(value) ? value.join(', ') : typeof value === 'object' && value ? JSON.stringify(value) : String(value)}</dd></div>
                  ))}
                </dl>
              </div>
            ) : null}
            {canReview ? (
              <div className="rounded-2xl border border-line p-3">
                <Field label="Review note (optional)"><textarea className={inputClass} rows={2} value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></Field>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="ghost" disabled={busy || row.status === 'REVIEW'} onClick={() => review('REVIEW')}>Under review</Button>
                  <Button disabled={busy || row.status === 'CONFIRMED'} onClick={() => review('CONFIRMED')}>Confirm</Button>
                  <Button variant="ghost" disabled={busy || row.status === 'DISMISSED'} onClick={() => review('DISMISSED')}>Dismiss as expected</Button>
                  <Button variant="ghost" disabled={busy || row.status === 'RESOLVED'} onClick={() => review('RESOLVED')}>Resolved</Button>
                </div>
              </div>
            ) : null}
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Related transactions (window around detection)</p>
              {row.relatedTransactions.length ? (
                <Table head={['Transaction', 'Status', 'Amount', 'Institution', 'Response', 'Time']} minWidth={560}>
                  {row.relatedTransactions.map((tx) => (
                    <tr key={tx.transactionId}>
                      <td>{canTx ? <Link className="text-brand" to={`/transactions/${tx.transactionId}`}>{tx.transactionId}</Link> : tx.transactionId}</td>
                      <td><StatusBadge status={tx.status} /></td>
                      <td className="tabular-nums">{formatNpr(tx.amount)}</td>
                      <td>{tx.institution}</td>
                      <td className="tabular-nums">{fmtMs(tx.responseTimeMs)}</td>
                      <td className="text-muted">{fmtDateTime(tx.createdAt)}</td>
                    </tr>
                  ))}
                </Table>
              ) : <p className="text-muted">No matching transactions in the detection window.</p>}
            </div>
          </div>
        )
      })()}
    </Drawer>
  )
}
