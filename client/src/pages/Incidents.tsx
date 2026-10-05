import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { can, INCIDENT_STATUSES, SEVERITIES, type AiAction } from '@finopsx/shared'
import { api, errorMessage, idem } from '../api'
import { useAuth, useToast } from '../contexts'
import { fmtDateTime, fmtMs, humanize, queryString, relTime, useUrlFilters } from '../lib/format'
import { Badge, Button, Card, EmptyState, ErrorState, Field, inputClass, Modal, PageHeader, Pagination, Select, Skeleton, StatusBadge, Table } from '../components/ui'

type IncidentRow = {
  publicId: string
  title: string
  severity: string
  status: string
  incidentType: string
  team: string | null
  scenario: string | null
  affectedTransactionCount: number
  detectedAt: string
  resolvedAt: string | null
  reopenCount: number
  assignee: { id: string; name: string } | null
  services: Array<{ name: string }>
  institutions: Array<{ name: string }>
}

export function IncidentsPage() {
  const { user } = useAuth()
  const [filters, setFilters] = useUrlFilters({ status: '', severity: '', active: '', q: '', page: '1' })
  const [creating, setCreating] = useState(false)
  const params = queryString({ ...filters, limit: 25 })
  const query = useQuery({ queryKey: ['incidents', params], queryFn: () => api<{ items: IncidentRow[]; page: number; totalPages: number; total: number }>(`/api/incidents?${params}`), placeholderData: (previous) => previous })
  return (
    <div>
      <PageHeader
        title="Incidents"
        description="Detected automatically from live telemetry or created manually. Lifecycle: Detected → Acknowledged → Investigating → Identified → Mitigating → Resolved → Post-incident review."
        actions={user && can(user.role, 'incidents:manage') ? <Button onClick={() => setCreating(true)}>Create incident</Button> : null}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select label="Activity" value={filters.active} onChange={(active) => setFilters({ active })} options={[['', 'All incidents'], ['true', 'Active only']]} />
        <Select label="Status" value={filters.status} onChange={(status) => setFilters({ status })} options={[['', 'Any status'], ...INCIDENT_STATUSES.map((item) => [item, humanize(item)] as [string, string])]} />
        <Select label="Severity" value={filters.severity} onChange={(severity) => setFilters({ severity })} options={[['', 'Any severity'], ...SEVERITIES.map((item) => [item, humanize(item)] as [string, string])]} />
        <input aria-label="Search incidents" className="rounded-full border border-line bg-card px-3 py-1.5 text-sm" placeholder="INC-ID or title" value={filters.q} onChange={(event) => setFilters({ q: event.target.value })} />
      </div>
      {creating ? <CreateIncident onClose={() => setCreating(false)} /> : null}
      {query.isLoading ? <Skeleton className="h-64" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.items.length ? (
        <>
          <Table head={['Incident', 'Title', 'Severity', 'Status', 'Owner', 'Services', 'Detected', 'Affected']} minWidth={980}>
            {query.data.items.map((row) => (
              <tr key={row.publicId}>
                <td><Link className="font-medium text-brand" to={`/incidents/${row.publicId}`}>{row.publicId}</Link></td>
                <td>{row.title}{row.scenario ? <span className="ml-2"><Badge tone="info">demo scenario</Badge></span> : null}{row.reopenCount ? <span className="ml-1"><Badge tone="warn">reopened ×{row.reopenCount}</Badge></span> : null}</td>
                <td><StatusBadge status={row.severity} /></td>
                <td><StatusBadge status={row.status} /></td>
                <td className="text-muted">{row.assignee?.name ?? 'Unassigned'}{row.team ? <p className="text-[11px]">{row.team}</p> : null}</td>
                <td className="text-muted">{[...row.services.map((item) => item.name), ...row.institutions.map((item) => item.name)].join(', ') || '—'}</td>
                <td className="whitespace-nowrap text-muted">{relTime(row.detectedAt)}</td>
                <td className="tabular-nums">{row.affectedTransactionCount}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={(page) => setFilters({ page: String(page) })} />
        </>
      ) : <EmptyState title="No incidents match these filters." />}
    </div>
  )
}

function CreateIncident({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const client = useQueryClient()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState('MEDIUM')
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="Create incident" onClose={onClose}>
      <form className="grid gap-3" onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        try {
          await api('/api/incidents', { method: 'POST', headers: idem('inc'), body: JSON.stringify({ title, description, severity }) })
          toast.push('Incident created')
          client.invalidateQueries({ queryKey: ['incidents'] })
          onClose()
        } catch (error) { toast.push(errorMessage(error), 'err') } finally { setBusy(false) }
      }}>
        <Field label="Title"><input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} minLength={4} maxLength={140} required /></Field>
        <Field label="Description"><textarea className={inputClass} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} minLength={4} required /></Field>
        <Field label="Severity"><select className={inputClass} value={severity} onChange={(event) => setSeverity(event.target.value)}>{SEVERITIES.map((item) => <option key={item}>{item}</option>)}</select></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Create'}</Button></div>
      </form>
    </Modal>
  )
}

type Rca = {
  likelyCause: string | null
  confirmed: boolean
  confidence: number
  confidenceLabel: string
  evidence: Array<{ label: string; value: string; source: string; supports: boolean }>
  affectedServices: string[]
  affectedInstitutions: string[]
  impactedDependents: Array<{ name: string; status: string }>
  upstreamDependencies: Array<{ name: string; status: string }>
  correlatedAnomalies: Array<{ id: string; title: string }>
  recentChanges: Array<{ action: string; actor: string; at: string; detail: string | null }>
  recommendedActions: string[]
  actions: AiAction[]
  limitations: string
  generatedAt: string
}

type IncidentDetail = IncidentRow & {
  description: string
  rootCause: string | null
  rootCauseConfirmed: boolean
  resolution: string | null
  preventiveAction: string | null
  acknowledgedAt: string | null
  aiSummary: string | null
  aiLabel: string
  rca: Rca | null
  allowedTransitions: string[]
  timeline: Array<{ id: string; kind: string; message: string; actorEmail: string | null; timestamp: string }>
  anomalies: Array<{ publicId: string; title: string; type: string; severity: string; status: string; detectedAt: string }>
  affectedTransactions: Array<{ transactionId: string; institution: string; failureReason: string | null; responseTimeMs: number; createdAt: string }>
  services: Array<{ id: string; key: string; name: string; status: string }>
}

const KIND_TONE: Record<string, 'good' | 'bad' | 'warn' | 'info' | 'neutral'> = { DETECTED: 'bad', STATUS: 'info', ASSIGNMENT: 'neutral', SEVERITY: 'warn', NOTE: 'neutral', DETAILS: 'neutral', RESOLUTION: 'good', REOPEN: 'warn', RCA: 'info', CORRELATED: 'info', SYSTEM: 'neutral' }

export function IncidentDetailPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [modal, setModal] = useState<null | 'resolve' | 'reopen' | 'details' | 'severity'>(null)
  const query = useQuery({ queryKey: ['incident', id], queryFn: () => api<IncidentDetail>(`/api/incidents/${id}`) })
  const engineers = useQuery({ queryKey: ['engineers'], enabled: Boolean(user && can(user.role, 'incidents:assign')), queryFn: () => api<Array<{ id: string; name: string; role: string }>>('/api/engineers') })
  if (query.isLoading) return <Skeleton className="h-80" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} />
  const row = query.data!
  const manage = Boolean(user && can(user.role, 'incidents:manage'))
  const assign = Boolean(user && can(user.role, 'incidents:assign'))
  const isClosed = row.status === 'RESOLVED' || row.status === 'POST_INCIDENT_REVIEW'

  async function act(path: string, body: Record<string, unknown>, success: string) {
    setBusy(true)
    try {
      await api(`/api/incidents/${id}${path}`, { method: path ? 'POST' : 'PATCH', headers: idem(`inc-${id}`), body: JSON.stringify(body) })
      toast.push(success)
      setModal(null)
      client.invalidateQueries({ queryKey: ['incident', id] })
      client.invalidateQueries({ queryKey: ['incidents'] })
      return true
    } catch (error) {
      toast.push(errorMessage(error), 'err')
      return false
    } finally { setBusy(false) }
  }

  const stepIndex = INCIDENT_STATUSES.indexOf(row.status as (typeof INCIDENT_STATUSES)[number])
  return (
    <div className="space-y-4">
      <Link to="/incidents" className="text-sm text-brand">← Incidents</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{row.publicId} · {row.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <StatusBadge status={row.severity} /><StatusBadge status={row.status} />
            <span>{humanize(row.incidentType)}</span>
            <span>Detected {fmtDateTime(row.detectedAt)}</span>
            {row.acknowledgedAt ? <span>Acknowledged {fmtDateTime(row.acknowledgedAt)}</span> : null}
            {row.resolvedAt ? <span>Resolved {fmtDateTime(row.resolvedAt)}</span> : null}
            {row.scenario ? <Badge tone="info">Demo scenario: {humanize(row.scenario)}</Badge> : null}
          </div>
        </div>
        {manage ? (
          <div className="flex flex-wrap gap-2">
            {row.allowedTransitions.filter((status) => status !== 'RESOLVED').map((status) => (
              <Button key={status} variant="ghost" disabled={busy} onClick={() => act('/status', { status }, `Moved to ${humanize(status)}`)}>{humanize(status)}</Button>
            ))}
            {row.allowedTransitions.includes('RESOLVED') ? <Button disabled={busy} onClick={() => setModal('resolve')}>Resolve</Button> : null}
            {isClosed ? <Button variant="ghost" disabled={busy} onClick={() => setModal('reopen')}>Reopen</Button> : null}
          </div>
        ) : null}
      </div>

      <ol className="flex flex-wrap gap-1 text-[11px]" aria-label="Incident lifecycle">
        {INCIDENT_STATUSES.map((status, index) => (
          <li key={status} className={`rounded-full px-2.5 py-1 ${index < stepIndex ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' : index === stepIndex ? 'bg-brand text-white' : 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-slate-300'}`} aria-current={index === stepIndex ? 'step' : undefined}>
            {humanize(status)}
          </li>
        ))}
      </ol>

      <div className="grid gap-4 xl:grid-cols-[1.3fr_.7fr]">
        <div className="space-y-4">
          <Card title="Summary">
            <p className="text-sm">{row.description}</p>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-muted">Owner</dt><dd>{row.assignee?.name ?? 'Unassigned'}</dd></div>
              <div><dt className="text-xs text-muted">Team</dt><dd>{row.team ?? '—'}</dd></div>
              <div><dt className="text-xs text-muted">Services</dt><dd>{row.services.map((service) => service.name).join(', ') || '—'}</dd></div>
              <div><dt className="text-xs text-muted">Institutions</dt><dd>{row.institutions.map((item) => item.name).join(', ') || row.rca?.affectedInstitutions.join(', ') || '—'}</dd></div>
              <div><dt className="text-xs text-muted">Affected transactions</dt><dd>{row.affectedTransactionCount}</dd></div>
              <div><dt className="text-xs text-muted">Reopened</dt><dd>{row.reopenCount} time(s)</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-muted">Root cause {row.rootCauseConfirmed ? '(confirmed)' : '(not confirmed)'}</dt><dd>{row.rootCause ?? '—'}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-muted">Resolution</dt><dd>{row.resolution ?? '—'}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs text-muted">Preventive action</dt><dd>{row.preventiveAction ?? '—'}</dd></div>
            </dl>
            {manage ? <div className="mt-3 flex flex-wrap gap-2"><Button variant="ghost" onClick={() => setModal('details')}>Edit root cause & details</Button><Button variant="ghost" onClick={() => setModal('severity')}>Change severity</Button></div> : null}
          </Card>

          <RcaPanel rca={row.rca} rootCause={row.rootCause} confirmed={row.rootCauseConfirmed} label={row.aiLabel} onRerun={manage ? () => act('/rca', {}, 'Root cause analysis refreshed') : undefined} busy={busy} />

          <Card title="Affected transactions">
            {row.affectedTransactions.length ? (
              <Table head={['Transaction', 'Institution', 'Failure reason', 'Response', 'Time']} minWidth={560}>
                {row.affectedTransactions.map((tx) => (
                  <tr key={tx.transactionId}>
                    <td>{user && can(user.role, 'transactions:view') ? <Link className="text-brand" to={`/transactions/${tx.transactionId}`}>{tx.transactionId}</Link> : tx.transactionId}</td>
                    <td>{tx.institution}</td>
                    <td>{humanize(tx.failureReason)}</td>
                    <td className="tabular-nums">{fmtMs(tx.responseTimeMs)}</td>
                    <td className="text-muted">{fmtDateTime(tx.createdAt)}</td>
                  </tr>
                ))}
              </Table>
            ) : <p className="text-sm text-muted">No failed transactions are linked to this incident's scope and window.</p>}
          </Card>
        </div>

        <div className="space-y-4">
          {assign ? (
            <Card title="Assignment">
              <select className={inputClass} aria-label="Assign owner" value={row.assignee?.id ?? ''} disabled={busy} onChange={(event) => act('/assign', { assigneeId: event.target.value || null }, event.target.value ? 'Owner assigned' : 'Owner removed')}>
                <option value="">Unassigned</option>
                {engineers.data?.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.name} ({humanize(engineer.role)})</option>)}
              </select>
            </Card>
          ) : null}
          {manage ? (
            <Card title="Add note">
              <form onSubmit={async (event) => { event.preventDefault(); if (await act('/notes', { message: note }, 'Note added')) setNote('') }}>
                <textarea className={inputClass} rows={3} aria-label="Incident note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="What did you find or change?" />
                <Button className="mt-2" type="submit" disabled={busy || note.trim().length < 2}>Add note</Button>
              </form>
            </Card>
          ) : null}
          <Card title="Timeline">
            <ol className="space-y-3">
              {row.timeline.map((event) => (
                <li key={event.id} className="border-l-2 border-line pl-3">
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted"><Badge tone={KIND_TONE[event.kind] ?? 'neutral'}>{humanize(event.kind)}</Badge>{fmtDateTime(event.timestamp)} · {event.actorEmail ?? 'system'}</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm">{event.message}</p>
                </li>
              ))}
            </ol>
          </Card>
          {row.anomalies.length ? (
            <Card title="Linked anomalies">
              <ul className="space-y-1 text-sm">{row.anomalies.map((anomaly) => <li key={anomaly.publicId}><Link className="text-brand" to={`/anomalies?focus=${anomaly.publicId}`}>{anomaly.publicId}</Link> {anomaly.title} <StatusBadge status={anomaly.status} /></li>)}</ul>
            </Card>
          ) : null}
        </div>
      </div>

      {modal === 'resolve' ? <ResolveModal busy={busy} initialRootCause={row.rootCause ?? row.rca?.likelyCause ?? ''} onClose={() => setModal(null)} onSubmit={(body) => act('/resolve', body, 'Incident resolved')} /> : null}
      {modal === 'reopen' ? <ReasonModal title="Reopen incident" label="Why is it being reopened?" busy={busy} onClose={() => setModal(null)} onSubmit={(reason) => act('/reopen', { reason }, 'Incident reopened')} /> : null}
      {modal === 'severity' ? <SeverityModal current={row.severity} busy={busy} onClose={() => setModal(null)} onSubmit={(body) => act('/severity', body, 'Severity changed')} /> : null}
      {modal === 'details' ? <DetailsModal row={row} busy={busy} onClose={() => setModal(null)} onSubmit={(body) => act('', body, 'Incident updated')} /> : null}
    </div>
  )
}

function RcaPanel({ rca, rootCause, confirmed, label, onRerun, busy }: { rca: Rca | null; rootCause: string | null; confirmed: boolean; label: string; onRerun?: () => void; busy: boolean }) {
  return (
    <Card title="AI root cause analysis" action={onRerun ? <Button variant="ghost" disabled={busy} onClick={onRerun}>Re-run analysis</Button> : null}>
      {confirmed && rootCause ? (
        <div className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/50">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200">Confirmed root cause</p>
          <p className="mt-1">{rootCause}</p>
        </div>
      ) : null}
      {!rca ? <p className="text-sm text-muted">Analysis has not run yet.</p> : (
        <div className="space-y-3 text-sm">
          <div className="rounded-2xl border border-line p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Likely cause{confirmed ? ' (AI suggestion)' : ''}</p>
            <p className="mt-1">{rca.likelyCause ?? 'Not enough evidence to name a likely cause yet. Keep the incident open while metrics accumulate.'}</p>
            {rca.likelyCause ? <p className="mt-2 text-xs text-muted">Confidence: <strong>{rca.confidenceLabel}</strong> ({Math.round(rca.confidence * 100)}%) · generated {relTime(rca.generatedAt)}</p> : null}
          </div>
          {rca.evidence.length ? (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Evidence</p>
              <ul className="space-y-1">
                {rca.evidence.map((item, index) => (
                  <li key={index} className="flex gap-2">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.supports ? 'bg-brand' : 'bg-slate-300'}`} aria-label={item.supports ? 'supports the likely cause' : 'context only'} />
                    <span><strong className="font-medium">{item.label}:</strong> {item.value} <span className="text-[11px] text-muted">({item.source})</span></span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {rca.recommendedActions.length ? (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Recommended next steps</p>
              <ul className="list-disc space-y-0.5 pl-5">{rca.recommendedActions.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : null}
          {rca.impactedDependents.length || rca.upstreamDependencies.length ? (
            <p className="text-xs text-muted">Upstream: {rca.upstreamDependencies.map((dep) => `${dep.name} (${dep.status.toLowerCase()})`).join(', ') || '—'} · Dependents: {rca.impactedDependents.map((dep) => `${dep.name} (${dep.status.toLowerCase()})`).join(', ') || '—'}</p>
          ) : null}
          {rca.actions.length ? <div className="flex flex-wrap gap-2">{rca.actions.map((action) => <Link key={action.href + action.label} to={action.href} className="rounded-full border border-line px-3 py-1 text-xs text-brand hover:bg-[#f4f6fa] dark:hover:bg-white/5">{action.label}</Link>)}</div> : null}
          <p className="text-[11px] text-amber-700 dark:text-amber-300">{rca.limitations || label}</p>
        </div>
      )}
    </Card>
  )
}

function ResolveModal({ busy, initialRootCause, onClose, onSubmit }: { busy: boolean; initialRootCause: string; onClose: () => void; onSubmit: (body: { resolution: string; rootCause?: string; preventiveAction?: string }) => void }) {
  const [resolution, setResolution] = useState('')
  const [rootCause, setRootCause] = useState(initialRootCause)
  const [preventiveAction, setPreventiveAction] = useState('')
  return (
    <Modal title="Resolve incident" onClose={onClose}>
      <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit({ resolution, rootCause: rootCause || undefined, preventiveAction: preventiveAction || undefined }) }}>
        <Field label="Resolution (required)"><textarea className={inputClass} rows={3} value={resolution} onChange={(event) => setResolution(event.target.value)} required minLength={4} /></Field>
        <Field label="Root cause"><textarea className={inputClass} rows={2} value={rootCause} onChange={(event) => setRootCause(event.target.value)} /></Field>
        <Field label="Preventive action"><textarea className={inputClass} rows={2} value={preventiveAction} onChange={(event) => setPreventiveAction(event.target.value)} /></Field>
        <p className="text-xs text-muted">Resolving also resolves linked anomalies and, for demo scenarios, ends the running scenario. The action is audited.</p>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || resolution.trim().length < 4}>{busy ? 'Resolving…' : 'Resolve'}</Button></div>
      </form>
    </Modal>
  )
}

function ReasonModal({ title, label, busy, onClose, onSubmit }: { title: string; label: string; busy: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <Modal title={title} onClose={onClose}>
      <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit(reason) }}>
        <Field label={label}><textarea className={inputClass} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} required minLength={4} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || reason.trim().length < 4}>Confirm</Button></div>
      </form>
    </Modal>
  )
}

function SeverityModal({ current, busy, onClose, onSubmit }: { current: string; busy: boolean; onClose: () => void; onSubmit: (body: { severity: string; reason?: string }) => void }) {
  const [severity, setSeverity] = useState(current)
  const [reason, setReason] = useState('')
  return (
    <Modal title="Change severity" onClose={onClose}>
      <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit({ severity, reason: reason || undefined }) }}>
        <Field label="Severity"><select className={inputClass} value={severity} onChange={(event) => setSeverity(event.target.value)}>{SEVERITIES.map((item) => <option key={item}>{item}</option>)}</select></Field>
        <Field label="Reason"><input className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || severity === current}>Save</Button></div>
      </form>
    </Modal>
  )
}

function DetailsModal({ row, busy, onClose, onSubmit }: { row: IncidentDetail; busy: boolean; onClose: () => void; onSubmit: (body: Record<string, unknown>) => void }) {
  const [rootCause, setRootCause] = useState(row.rootCause ?? '')
  const [confirmed, setConfirmed] = useState(row.rootCauseConfirmed)
  const [preventiveAction, setPreventiveAction] = useState(row.preventiveAction ?? '')
  const [team, setTeam] = useState(row.team ?? '')
  return (
    <Modal title="Edit incident details" onClose={onClose}>
      <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); onSubmit({ rootCause, rootCauseConfirmed: confirmed, preventiveAction, team }) }}>
        <Field label="Root cause"><textarea className={inputClass} rows={3} value={rootCause} onChange={(event) => setRootCause(event.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Root cause confirmed by the team</label>
        <Field label="Preventive action"><textarea className={inputClass} rows={2} value={preventiveAction} onChange={(event) => setPreventiveAction(event.target.value)} /></Field>
        <Field label="Team"><input className={inputClass} value={team} onChange={(event) => setTeam(event.target.value)} maxLength={60} /></Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>Save</Button></div>
      </form>
    </Modal>
  )
}
