import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, RefreshCw } from 'lucide-react'
import { can, formatNpr, JOB_LABEL, type JobType } from '@finopsx/shared'
import { api, errorMessage, idem } from '../api'
import { useAuth, useToast } from '../contexts'
import { fmtDate, fmtDateTime, fmtMs, fmtPct, humanize, queryString, relTime, useUrlFilters } from '../lib/format'
import { Badge, Button, Card, Drawer, EmptyState, ErrorState, Field, inputClass, PageHeader, Pagination, Select, Skeleton, Stat, StatusBadge, Table } from '../components/ui'

/* ----------------------------------------------------------- Reconciliation */

type ReconRun = {
  id: string
  windowFrom: string
  windowTo: string
  institution: string
  status: string
  expectedCount: number
  actualCount: number
  matchedCount: number
  unmatchedCount: number
  expectedAmount: number
  actualAmount: number
  difference: number
  settledCount: number
  settledAmount: number
  settlementDifference: number
  matchRate: number
  notes: string | null
  createdBy: string
  createdAt: string
}

const ISSUE_LABEL: Record<string, string> = {
  MISSING_AT_INSTITUTION: 'Missing at institution',
  MISSING_ON_PLATFORM: 'Missing on platform',
  AMOUNT_MISMATCH: 'Amount mismatch',
  NOT_SETTLED: 'Not yet settled',
}

const INSTITUTIONS: Array<[string, string]> = [['', 'All institutions'], ['DBA', 'Demo Bank A'], ['DBB', 'Demo Bank B'], ['DBC', 'Demo Bank C'], ['DWL', 'Demo Wallet'], ['DPN', 'Demo Payment Network'], ['DMN', 'Demo Merchant Network']]

export function ReconciliationPage() {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [filters, setFilters] = useUrlFilters({ status: '', page: '1', run: '', tab: 'runs' })
  const [range, setRange] = useState('today')
  const [institution, setInstitution] = useState('')
  const [busy, setBusy] = useState(false)
  const params = queryString({ status: filters.status, page: filters.page, limit: 20 })
  const query = useQuery({ queryKey: ['reconciliation', params], queryFn: () => api<{ items: ReconRun[]; page: number; totalPages: number; summary: { latest: ReconRun | null; openRuns: number } }>(`/api/reconciliation?${params}`), placeholderData: (previous) => previous })
  const canRun = Boolean(user && can(user.role, 'reconciliation:run'))

  async function run() {
    setBusy(true)
    try {
      const result = await api<{ id: string; status: string; unmatchedCount: number }>('/api/reconciliation/run', { method: 'POST', headers: idem('recon'), body: JSON.stringify({ range, institution: institution || undefined }) })
      toast.push(`${result.id}: ${humanize(result.status)} (${result.unmatchedCount} unmatched)`)
      client.invalidateQueries({ queryKey: ['reconciliation'] })
      setFilters({ run: result.id, page: filters.page })
    } catch (error) { toast.push(errorMessage(error), 'err') } finally { setBusy(false) }
  }

  const latest = query.data?.summary.latest
  return (
    <div className="space-y-4">
      <PageHeader
        title="Reconciliation"
        description="Compares successful platform transactions with the synthetic institution ledger and settlement batches. Each mismatch is listed with its reason."
        actions={canRun ? (
          <div className="flex flex-wrap items-end gap-2">
            <Select label="Window" value={range} onChange={setRange} options={[['today', 'Today'], ['yesterday', 'Yesterday'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days']]} />
            <Select label="Institution" value={institution} onChange={setInstitution} options={INSTITUTIONS} />
            <Button onClick={run} disabled={busy}><Play className="mr-1 inline h-4 w-4" />{busy ? 'Running…' : 'Run reconciliation'}</Button>
          </div>
        ) : null}
      />
      {latest ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Latest run" value={<button className="text-brand" onClick={() => setFilters({ run: latest.id, page: filters.page })}>{latest.id}</button>} hint={`${latest.institution} · ${relTime(latest.createdAt)}`} />
          <Stat label="Status" value={<StatusBadge status={latest.status} />} />
          <Stat label="Match rate" value={fmtPct(latest.matchRate, 2)} tone={latest.matchRate >= 99.5 ? 'good' : 'warn'} hint={`${latest.matchedCount.toLocaleString('en-US')} of ${latest.expectedCount.toLocaleString('en-US')}`} />
          <Stat label="Ledger difference" value={formatNpr(latest.difference)} tone={latest.difference ? 'bad' : 'good'} />
          <Stat label="Open runs" value={query.data?.summary.openRuns ?? 0} hint="Mismatch or investigating" tone={query.data?.summary.openRuns ? 'warn' : undefined} />
        </div>
      ) : null}

      <div className="inline-flex rounded-full border border-line bg-card p-1 text-sm" role="tablist">
        {[['runs', 'Reconciliation runs'], ['settlements', 'Settlement batches']].map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filters.tab === key} className={`rounded-full px-4 py-1.5 ${filters.tab === key ? 'bg-brand text-white' : ''}`} onClick={() => setFilters({ tab: key })}>{label}</button>
        ))}
      </div>

      {filters.tab === 'settlements' ? <Settlements /> : (
        <>
          <Select label="Status" value={filters.status} onChange={(status) => setFilters({ status })} options={[['', 'Any status'], ['MATCHED', 'Matched'], ['MISMATCH', 'Mismatch'], ['INVESTIGATING', 'Investigating'], ['RESOLVED', 'Resolved']]} />
          {query.isLoading ? <Skeleton className="h-48" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.items.length ? (
            <>
              <Table head={['Run', 'Window', 'Institution', 'Status', 'Expected', 'Matched', 'Unmatched', 'Ledger diff', 'Unsettled', 'By']} minWidth={1050}>
                {query.data.items.map((row) => (
                  <tr key={row.id}>
                    <td><button className="font-medium text-brand" onClick={() => setFilters({ run: row.id, page: filters.page })}>{row.id}</button></td>
                    <td className="whitespace-nowrap text-xs text-muted">{fmtDateTime(row.windowFrom)} – {fmtDateTime(row.windowTo)}</td>
                    <td>{row.institution}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td className="tabular-nums">{row.expectedCount.toLocaleString('en-US')}</td>
                    <td className="tabular-nums">{row.matchedCount.toLocaleString('en-US')}</td>
                    <td className={`tabular-nums ${row.unmatchedCount ? 'text-red-600' : ''}`}>{row.unmatchedCount}</td>
                    <td className="tabular-nums">{formatNpr(row.difference)}</td>
                    <td className="tabular-nums">{formatNpr(row.settlementDifference)}</td>
                    <td className="text-xs text-muted">{row.createdBy}</td>
                  </tr>
                ))}
              </Table>
              <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={(page) => setFilters({ page: String(page) })} />
            </>
          ) : filters.status
            ? <EmptyState title={`No ${humanize(filters.status).toLowerCase()} runs.`} detail="Choose another status to see other runs." />
            : <EmptyState title="No reconciliation runs yet." detail={canRun ? 'Run one above or trigger the Transaction Reconciliation job.' : undefined} />}
        </>
      )}
      {filters.run ? <ReconDrawer id={filters.run} canRun={canRun} onClose={() => setFilters({ run: '', page: filters.page })} /> : null}
    </div>
  )
}

function ReconDrawer({ id, canRun, onClose }: { id: string; canRun: boolean; onClose: () => void }) {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [issue, setIssue] = useState('')
  const [page, setPage] = useState(1)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const query = useQuery({
    queryKey: ['reconciliation', 'run', id, issue, page],
    queryFn: () => api<ReconRun & { issues: Array<{ issue: string; count: number }>; items: { items: Array<{ id: string; transactionRef: string; institution: string | null; issue: string; platformAmount: number | null; institutionAmount: number | null }>; page: number; totalPages: number; total: number } }>(`/api/reconciliation/${id}?${queryString({ issue, page, limit: 25 })}`),
    placeholderData: (previous) => previous,
  })
  const canTx = Boolean(user && can(user.role, 'transactions:view'))

  async function update(status: 'INVESTIGATING' | 'RESOLVED') {
    setBusy(true)
    try {
      await api(`/api/reconciliation/${id}`, { method: 'PATCH', headers: idem(`recon-${id}`), body: JSON.stringify({ status, notes: notes || undefined }) })
      toast.push(`Marked ${humanize(status).toLowerCase()}`)
      setNotes('')
      client.invalidateQueries({ queryKey: ['reconciliation'] })
    } catch (error) { toast.push(errorMessage(error), 'err') } finally { setBusy(false) }
  }

  return (
    <Drawer title={`Reconciliation ${id}`} onClose={onClose} wide>
      {query.isLoading ? <Skeleton className="h-64" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : (() => {
        const row = query.data!
        return (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={row.status} /><span className="text-muted">{row.institution} · {fmtDateTime(row.windowFrom)} – {fmtDateTime(row.windowTo)}</span></div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Platform (expected)" value={row.expectedCount.toLocaleString('en-US')} hint={formatNpr(row.expectedAmount)} />
              <Stat label="Institution records" value={row.actualCount.toLocaleString('en-US')} hint={formatNpr(row.actualAmount)} />
              <Stat label="Matched" value={row.matchedCount.toLocaleString('en-US')} hint={fmtPct(row.matchRate, 2)} tone="good" />
              <Stat label="Unmatched" value={row.unmatchedCount} tone={row.unmatchedCount ? 'bad' : 'good'} hint={`Ledger diff ${formatNpr(row.difference)}`} />
              <Stat label="Settled" value={row.settledCount.toLocaleString('en-US')} hint={formatNpr(row.settledAmount)} />
              <Stat label="Unsettled value" value={formatNpr(row.settlementDifference)} />
            </div>
            {row.notes ? <p className="whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs dark:bg-white/5">{row.notes}</p> : null}
            {canRun && row.status !== 'MATCHED' ? (
              <div className="rounded-2xl border border-line p-3">
                <Field label="Investigation note (optional)"><textarea className={inputClass} rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} /></Field>
                <div className="mt-2 flex gap-2">
                  <Button variant="ghost" disabled={busy || row.status === 'INVESTIGATING'} onClick={() => update('INVESTIGATING')}>Mark investigating</Button>
                  <Button disabled={busy || row.status === 'RESOLVED'} onClick={() => update('RESOLVED')}>Mark resolved</Button>
                </div>
              </div>
            ) : null}
            <div>
              <div className="mb-2 flex flex-wrap gap-2">
                <button className={`rounded-full border px-3 py-1 text-xs ${issue === '' ? 'border-brand bg-brand text-white' : 'border-line'}`} onClick={() => { setIssue(''); setPage(1) }}>All issues ({row.issues.reduce((sum, item) => sum + item.count, 0)})</button>
                {row.issues.map((item) => <button key={item.issue} className={`rounded-full border px-3 py-1 text-xs ${issue === item.issue ? 'border-brand bg-brand text-white' : 'border-line'}`} onClick={() => { setIssue(item.issue); setPage(1) }}>{ISSUE_LABEL[item.issue] ?? humanize(item.issue)} ({item.count})</button>)}
              </div>
              {row.items.items.length ? (
                <>
                  <Table head={['Transaction', 'Institution', 'Issue', 'Platform amount', 'Institution amount']} minWidth={600}>
                    {row.items.items.map((item) => (
                      <tr key={item.id}>
                        <td>{canTx && item.issue !== 'MISSING_ON_PLATFORM' ? <Link className="text-brand" to={`/transactions/${item.transactionRef}`}>{item.transactionRef}</Link> : item.transactionRef}</td>
                        <td>{item.institution ?? '—'}</td>
                        <td><Badge tone={item.issue === 'NOT_SETTLED' ? 'warn' : 'bad'}>{ISSUE_LABEL[item.issue] ?? humanize(item.issue)}</Badge></td>
                        <td className="tabular-nums">{item.platformAmount == null ? '—' : formatNpr(item.platformAmount)}</td>
                        <td className="tabular-nums">{item.institutionAmount == null ? '—' : formatNpr(item.institutionAmount)}</td>
                      </tr>
                    ))}
                  </Table>
                  <Pagination page={row.items.page} totalPages={row.items.totalPages} onPage={setPage} />
                </>
              ) : <p className="text-muted">No mismatched records. Every platform transaction in this window has a matching institution record.</p>}
            </div>
          </div>
        )
      })()}
    </Drawer>
  )
}

function Settlements() {
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const query = useQuery({ queryKey: ['settlements', status, page], queryFn: () => api<{ items: Array<{ id: string; institution: string; status: string; transactionCount: number; amount: number; createdAt: string; settledAt: string | null }>; page: number; totalPages: number }>(`/api/settlements?${queryString({ status, page, limit: 20 })}`), placeholderData: (previous) => previous })
  return (
    <div className="space-y-3">
      <Select label="Status" value={status} onChange={(value) => { setStatus(value); setPage(1) }} options={[['', 'Any status'], ['PENDING', 'Pending'], ['PROCESSING', 'Processing'], ['SETTLED', 'Settled'], ['DELAYED', 'Delayed'], ['FAILED', 'Failed']]} />
      {query.isLoading ? <Skeleton className="h-48" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.items.length ? (
        <>
          <Table head={['Batch', 'Institution', 'Status', 'Transactions', 'Amount', 'Created', 'Settled']} minWidth={760}>
            {query.data.items.map((row) => (
              <tr key={row.id}>
                <td className="font-mono text-xs">{row.id}</td>
                <td>{row.institution}</td>
                <td><StatusBadge status={row.status} /></td>
                <td className="tabular-nums">{row.transactionCount.toLocaleString('en-US')}</td>
                <td className="tabular-nums">{formatNpr(row.amount)}</td>
                <td className="text-muted">{fmtDateTime(row.createdAt)}</td>
                <td className="text-muted">{fmtDateTime(row.settledAt)}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={setPage} />
        </>
      ) : <EmptyState title="No settlement batches." detail="Batches are created by the settlement cycle and the EOD Settlement job." />}
    </div>
  )
}

/* --------------------------------------------------------- Operational jobs */

type JobRun = { id: string; type: JobType; label: string; cadence: string; status: string; startedAt: string | null; finishedAt: string | null; durationMs: number | null; recordsProcessed: number; successfulRecords: number; failedRecords: number; triggeredBy: string; output: Record<string, unknown> | null; error: string | null; createdAt: string }

export function JobsPage() {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [filters, setFilters] = useUrlFilters({ type: '', status: '', page: '1', job: '' })
  const [running, setRunning] = useState<string | null>(null)
  const params = queryString({ type: filters.type, status: filters.status, page: filters.page, limit: 20 })
  const query = useQuery({
    queryKey: ['jobs', params],
    queryFn: () => api<{ items: JobRun[]; page: number; totalPages: number; catalog: Array<{ type: JobType; label: string; cadence: string; description: string; lastRun: JobRun | null }> }>(`/api/jobs?${params}`),
    placeholderData: (previous) => previous,
    refetchInterval: (q) => q.state.data?.items.some((row) => row.status === 'RUNNING' || row.status === 'QUEUED') ? 2000 : false,
  })
  const canRun = Boolean(user && can(user.role, 'jobs:run'))

  async function trigger(type: JobType) {
    setRunning(type)
    try {
      const job = await api<{ id: string }>(`/api/jobs/${type}/run`, { method: 'POST', headers: idem(`job-${type}`), body: JSON.stringify({}) })
      toast.push(`${JOB_LABEL[type]} started (${job.id})`)
      client.invalidateQueries({ queryKey: ['jobs'] })
    } catch (error) { toast.push(errorMessage(error), 'err') } finally { setRunning(null) }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Operational Jobs" description="End-of-day (EOD) and beginning-of-day (BOD) batch jobs. They run on schedule and can be triggered manually; a job of the same type cannot run twice at once." />
      {query.data ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {query.data.catalog.map((job) => (
            <div key={job.type} className="flex flex-col rounded-2xl border border-line bg-card p-4 shadow-card">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{job.label}</p>
                <Badge tone="info">{job.cadence}</Badge>
              </div>
              <p className="mt-1 flex-1 text-xs text-muted">{job.description}</p>
              <div className="mt-3 flex items-center justify-between gap-2 text-xs">
                <span className="text-muted">{job.lastRun ? <>Last: <StatusBadge status={job.lastRun.status} /> {relTime(job.lastRun.createdAt)}</> : 'Never run'}</span>
                {canRun ? <Button variant="ghost" disabled={running === job.type || job.lastRun?.status === 'RUNNING'} onClick={() => trigger(job.type)}><Play className="mr-1 inline h-3.5 w-3.5" />{running === job.type ? 'Starting…' : 'Run now'}</Button> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Select label="Job" value={filters.type} onChange={(type) => setFilters({ type })} options={[['', 'All jobs'], ...Object.entries(JOB_LABEL) as Array<[string, string]>]} />
        <Select label="Status" value={filters.status} onChange={(status) => setFilters({ status })} options={[['', 'Any status'], ['QUEUED', 'Queued'], ['RUNNING', 'Running'], ['COMPLETED', 'Completed'], ['FAILED', 'Failed']]} />
        <Button variant="quiet" onClick={() => query.refetch()} aria-label="Refresh job runs"><RefreshCw className="h-4 w-4" /></Button>
      </div>
      {query.isLoading ? <Skeleton className="h-48" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.items.length ? (
        <>
          <Table head={['Run', 'Job', 'Status', 'Started', 'Duration', 'Processed', 'Successful', 'Failed', 'Triggered by']} minWidth={980}>
            {query.data.items.map((row) => (
              <tr key={row.id}>
                <td><button className="font-medium text-brand" onClick={() => setFilters({ job: row.id, page: filters.page })}>{row.id}</button></td>
                <td>{row.label}</td>
                <td><StatusBadge status={row.status} /></td>
                <td className="whitespace-nowrap text-muted">{fmtDateTime(row.startedAt ?? row.createdAt)}</td>
                <td className="tabular-nums">{fmtMs(row.durationMs)}</td>
                <td className="tabular-nums">{row.recordsProcessed.toLocaleString('en-US')}</td>
                <td className="tabular-nums">{row.successfulRecords.toLocaleString('en-US')}</td>
                <td className={`tabular-nums ${row.failedRecords ? 'text-red-600' : ''}`}>{row.failedRecords.toLocaleString('en-US')}</td>
                <td className="text-xs text-muted">{row.triggeredBy}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={(page) => setFilters({ page: String(page) })} />
        </>
      ) : <EmptyState title="No job runs match these filters." />}
      {filters.job ? <JobDrawer id={filters.job} onClose={() => setFilters({ job: '', page: filters.page })} /> : null}
    </div>
  )
}

function JobDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const query = useQuery({ queryKey: ['job', id], queryFn: () => api<JobRun>(`/api/jobs/${id}`), refetchInterval: (q) => q.state.data?.status === 'RUNNING' || q.state.data?.status === 'QUEUED' ? 1500 : false })
  return (
    <Drawer title={`Job ${id}`} onClose={onClose}>
      {query.isLoading ? <Skeleton className="h-48" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : (() => {
        const row = query.data!
        const output = row.output ?? {}
        const links: Array<[string, string]> = []
        if (typeof output.reconciliationId === 'string') links.push([`/reconciliation?run=${output.reconciliationId}`, `Open ${output.reconciliationId}`])
        if (typeof output.reportId === 'string') links.push([`/reports/${output.reportId}`, 'Open generated report'])
        if (row.type === 'DATA_VALIDATION') links.push(['/data-quality', 'Open data quality'])
        return (
          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2"><p className="font-medium">{row.label}</p><StatusBadge status={row.status} /></div>
            <dl className="grid grid-cols-2 gap-2 text-xs">
              <div><dt className="text-muted">Started</dt><dd>{fmtDateTime(row.startedAt)}</dd></div>
              <div><dt className="text-muted">Finished</dt><dd>{fmtDateTime(row.finishedAt)}</dd></div>
              <div><dt className="text-muted">Duration</dt><dd>{fmtMs(row.durationMs)}</dd></div>
              <div><dt className="text-muted">Triggered by</dt><dd>{row.triggeredBy}</dd></div>
              <div><dt className="text-muted">Processed</dt><dd>{row.recordsProcessed.toLocaleString('en-US')}</dd></div>
              <div><dt className="text-muted">Successful / failed</dt><dd>{row.successfulRecords.toLocaleString('en-US')} / {row.failedRecords.toLocaleString('en-US')}</dd></div>
            </dl>
            {row.error ? <p className="rounded-xl bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950 dark:text-red-200" role="alert">{row.error}</p> : null}
            {links.length ? <div className="flex flex-wrap gap-2">{links.map(([href, label]) => <Link key={href} to={href} className="rounded-full border border-line px-3 py-1 text-xs text-brand">{label} →</Link>)}</div> : null}
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Output</p>
              <pre className="max-h-96 overflow-auto rounded-xl bg-slate-50 p-3 text-xs dark:bg-white/5">{JSON.stringify(output, null, 2)}</pre>
            </div>
          </div>
        )
      })()}
    </Drawer>
  )
}

/* ------------------------------------------------------------- Data quality */

type DqIssue = { id: string; type: string; title: string; description: string; dimension: string; affectedCount: number; affectedPct: number; status: string; note: string | null; detectedAt: string; lastCheckedAt: string; resolvedAt: string | null }

export function DataQualityPage() {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [filters, setFilters] = useUrlFilters({ issue: '' })
  const [scanning, setScanning] = useState(false)
  const query = useQuery({ queryKey: ['data-quality'], queryFn: () => api<{ totalRecords: number; lastCheckedAt: string | null; metrics: { completeness: number; accuracy: number; duplicateRate: number; invalidIds: number; missingFields: number; delayedEvents: number }; issues: DqIssue[] }>('/api/data-quality') })
  const canManage = Boolean(user && can(user.role, 'dataquality:manage'))

  async function scan() {
    setScanning(true)
    try {
      await api('/api/data-quality/scan', { method: 'POST', body: JSON.stringify({}) })
      toast.push('Data quality scan complete')
      client.invalidateQueries({ queryKey: ['data-quality'] })
    } catch (error) { toast.push(errorMessage(error), 'err') } finally { setScanning(false) }
  }

  if (query.isLoading) return <Skeleton className="h-80" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} />
  const data = query.data!
  const m = data.metrics
  return (
    <div className="space-y-4">
      <PageHeader
        title="Data Quality"
        description={<>Rule-based checks over {data.totalRecords.toLocaleString('en-US')} synthetic transactions. Last scan {data.lastCheckedAt ? `${fmtDateTime(data.lastCheckedAt)} (${relTime(data.lastCheckedAt)})` : 'has not run yet'}.</>}
        actions={canManage ? <Button onClick={scan} disabled={scanning}><RefreshCw className={`mr-1 inline h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />{scanning ? 'Scanning…' : 'Run scan now'}</Button> : null}
      />
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Completeness" value={fmtPct(m.completeness, 2)} tone={m.completeness >= 99 ? 'good' : 'warn'} hint="Rows with all required fields" />
        <Stat label="Accuracy" value={fmtPct(m.accuracy, 2)} tone={m.accuracy >= 99 ? 'good' : 'warn'} hint="Valid IDs and matching ledger" />
        <Stat label="Duplicate rate" value={fmtPct(m.duplicateRate, 3)} tone={m.duplicateRate > 0 ? 'warn' : 'good'} hint="Shared correlation IDs" />
        <Stat label="Invalid IDs" value={m.invalidIds.toLocaleString('en-US')} tone={m.invalidIds ? 'warn' : undefined} />
        <Stat label="Missing fields" value={m.missingFields.toLocaleString('en-US')} tone={m.missingFields ? 'warn' : undefined} />
        <Stat label="Delayed events" value={m.delayedEvents.toLocaleString('en-US')} tone={m.delayedEvents ? 'warn' : undefined} hint="Delayed settlements" />
      </div>
      <Card title="Checks">
        {data.issues.length ? (
          <Table head={['Check', 'Dimension', 'Affected', 'Share', 'Status', 'Last checked', '']} minWidth={820}>
            {data.issues.map((issue) => (
              <tr key={issue.id}>
                <td><p className="font-medium">{issue.title}</p><p className="max-w-md text-[11px] text-muted">{issue.description}</p></td>
                <td>{humanize(issue.dimension)}</td>
                <td className={`tabular-nums ${issue.affectedCount ? 'font-medium' : 'text-muted'}`}>{issue.affectedCount.toLocaleString('en-US')}</td>
                <td className="tabular-nums">{fmtPct(issue.affectedPct, 3)}</td>
                <td><StatusBadge status={issue.affectedCount ? issue.status : 'PASSED'} /></td>
                <td className="whitespace-nowrap text-muted">{relTime(issue.lastCheckedAt)}</td>
                <td>{issue.affectedCount ? <Button variant="ghost" onClick={() => setFilters({ issue: issue.id })}>View records</Button> : null}</td>
              </tr>
            ))}
          </Table>
        ) : <EmptyState title="No checks have run yet." detail={canManage ? 'Run a scan to populate the checks.' : undefined} />}
      </Card>
      {filters.issue ? <DqDrawer issue={data.issues.find((item) => item.id === filters.issue || item.type === filters.issue)} id={filters.issue} canManage={canManage} onClose={() => setFilters({ issue: '' })} /> : null}
    </div>
  )
}

function DqDrawer({ id, issue, canManage, onClose }: { id: string; issue?: DqIssue; canManage: boolean; onClose: () => void }) {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [page, setPage] = useState(1)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const query = useQuery({
    queryKey: ['data-quality', 'records', id, page],
    queryFn: () => api<{ issue: Pick<DqIssue, 'id' | 'type' | 'title' | 'status'>; records: { items: Array<{ transactionId: string; correlationId: string; customerId: string; merchantReference: string | null; status: string; responseCode: string | null; failureReason: string | null; settlementStatus: string; amount: number; institution: string; merchant: string; createdAt: string }>; page: number; totalPages: number; total: number } }>(`/api/data-quality/${id}/records?page=${page}&limit=25`),
    placeholderData: (previous) => previous,
  })
  const canTx = Boolean(user && can(user.role, 'transactions:view'))
  const current = issue

  async function update(status: 'OPEN' | 'INVESTIGATING' | 'RESOLVED') {
    setBusy(true)
    try {
      await api(`/api/data-quality/${current?.id ?? query.data?.issue.id ?? id}`, { method: 'PATCH', headers: idem(`dq-${id}`), body: JSON.stringify({ status, note: note || undefined }) })
      toast.push(`Marked ${humanize(status).toLowerCase()}`)
      setNote('')
      client.invalidateQueries({ queryKey: ['data-quality'] })
    } catch (error) { toast.push(errorMessage(error), 'err') } finally { setBusy(false) }
  }

  return (
    <Drawer title={current?.title ?? query.data?.issue.title ?? 'Affected records'} onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        {current ? (
          <>
            <p className="text-muted">{current.description}</p>
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={current.status} /><span className="text-xs text-muted">{current.affectedCount.toLocaleString('en-US')} records · detected {fmtDate(current.detectedAt)}</span></div>
            {current.note ? <p className="rounded-xl bg-slate-50 p-3 text-xs dark:bg-white/5">{current.note}</p> : null}
          </>
        ) : null}
        {canManage ? (
          <div className="rounded-2xl border border-line p-3">
            <Field label="Note (optional)"><textarea className={inputClass} rows={2} value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></Field>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="ghost" disabled={busy || current?.status === 'INVESTIGATING'} onClick={() => update('INVESTIGATING')}>Investigating</Button>
              <Button disabled={busy || current?.status === 'RESOLVED'} onClick={() => update('RESOLVED')}>Resolved</Button>
              <Button variant="ghost" disabled={busy || current?.status === 'OPEN'} onClick={() => update('OPEN')}>Reopen</Button>
            </div>
          </div>
        ) : null}
        {query.isLoading ? <Skeleton className="h-48" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.records.items.length ? (
          <>
            <Table head={['Transaction', 'Customer', 'Merchant ref', 'Status', 'Response', 'Settlement', 'Amount', 'Institution', 'Created']} minWidth={980}>
              {query.data.records.items.map((row) => (
                <tr key={row.transactionId}>
                  <td>{canTx ? <Link className="text-brand" to={`/transactions/${row.transactionId}`}>{row.transactionId}</Link> : row.transactionId}</td>
                  <td className="font-mono text-xs">{row.customerId}</td>
                  <td className="text-xs">{row.merchantReference ?? <Badge tone="warn">missing</Badge>}</td>
                  <td><StatusBadge status={row.status} /></td>
                  <td className="text-xs">{row.responseCode ?? <Badge tone="warn">missing</Badge>}</td>
                  <td><StatusBadge status={row.settlementStatus} /></td>
                  <td className="tabular-nums">{formatNpr(row.amount)}</td>
                  <td>{row.institution}</td>
                  <td className="text-muted">{fmtDateTime(row.createdAt)}</td>
                </tr>
              ))}
            </Table>
            <Pagination page={query.data.records.page} totalPages={query.data.records.totalPages} onPage={setPage} />
          </>
        ) : <p className="text-muted">No affected records right now.</p>}
      </div>
    </Drawer>
  )
}
