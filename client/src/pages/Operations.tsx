import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { can, formatDuration, formatNpr, formatPercent } from '@finopsx/shared'
import { api } from '../api'
import { useAuth, useToast } from '../contexts'
import { Button, Card, ConfirmDialog, EmptyState, ErrorState, inputClass, Pagination, Skeleton, StatusBadge } from '../components/ui'

export function SystemHealthPage() {
  const query = useQuery({ queryKey: ['health'], queryFn: () => api<{
    services: Array<{ name: string; status: string; responseTimeMs: number; uptime: number; lastCheckedAt: string }>
    apis: Array<{ method: string; endpoint: string; status: string; latencyMs: number; rpm: number; errorRate: number; p95Ms: number; p99Ms: number; availability: number }>
    infrastructure: { label: string; cpu: number; memory: number; dbConnections: number; redis: string; queueLength: number; recordedAt: string }
  }>('/api/system/health'), refetchInterval: 15000 })
  if (query.isLoading) return <Skeleton className="h-64" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={(query.error as { message: string }).message} />
  const data = query.data!
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">System health</h1>
      <Card title="Services">
        <div className="table-wrap"><table className="w-full text-left text-sm"><thead className="text-xs text-muted"><tr><th>Service</th><th>Status</th><th>Response</th><th>Uptime</th><th>Checked</th></tr></thead><tbody>{data.services.map((service) => <tr key={service.name} className="border-t border-line"><td className="py-2">{service.name}</td><td><StatusBadge status={service.status} /></td><td>{formatDuration(service.responseTimeMs)}</td><td>{formatPercent(service.uptime)}</td><td>{new Date(service.lastCheckedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kathmandu' })}</td></tr>)}</tbody></table></div>
      </Card>
      <Card title="APIs">
        <div className="table-wrap"><table className="w-full min-w-[760px] text-left text-sm"><thead className="text-xs text-muted"><tr><th>Endpoint</th><th>Status</th><th>Latency</th><th>P95</th><th>P99</th><th>Req/min</th><th>Error</th><th>Availability</th></tr></thead><tbody>{data.apis.map((apiRow) => <tr key={apiRow.method + apiRow.endpoint} className="border-t border-line"><td className="py-2">{apiRow.method} {apiRow.endpoint}</td><td><StatusBadge status={apiRow.status} /></td><td>{formatDuration(apiRow.latencyMs)}</td><td>{formatDuration(apiRow.p95Ms)}</td><td>{formatDuration(apiRow.p99Ms)}</td><td>{apiRow.rpm.toLocaleString('en-US')}</td><td>{formatPercent(apiRow.errorRate)}</td><td>{formatPercent(apiRow.availability)}</td></tr>)}</tbody></table></div>
      </Card>
      <Card title="Infrastructure">
        <p className="mb-3 text-xs uppercase tracking-wide text-amber-700">{data.infrastructure.label}</p>
        <dl className="grid gap-3 sm:grid-cols-3 text-sm">
          <div>CPU {data.infrastructure.cpu.toFixed(1)}%</div>
          <div>Memory {data.infrastructure.memory.toFixed(1)}%</div>
          <div>DB connections {data.infrastructure.dbConnections}</div>
          <div>Redis {data.infrastructure.redis}</div>
          <div>Queue {data.infrastructure.queueLength}</div>
          <div>Recorded {new Date(data.infrastructure.recordedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}</div>
        </dl>
      </Card>
    </div>
  )
}

export function IncidentsPage() {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState(false)
  const query = useQuery({ queryKey: ['incidents', page], queryFn: () => api<{ items: Array<{ publicId: string; title: string; severity: string; status: string; createdAt: string; affectedTransactionCount: number }>; page: number; totalPages: number }>(`/api/incidents?page=${page}&limit=25`) })
  if (query.isLoading) return <Skeleton className="h-64" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  return (
    <div>
      <div className="mb-4 flex items-center justify-between"><h1 className="text-xl font-semibold">Incidents</h1>{user && can(user.role, 'incidents:manage') ? <Button onClick={() => setOpen(true)}>Create incident</Button> : null}</div>
      {open ? <CreateIncident onClose={() => setOpen(false)} onDone={() => { setOpen(false); client.invalidateQueries({ queryKey: ['incidents'] }); toast.push('Incident created') }} /> : null}
      {query.data?.items.length ? <div className="table-wrap rounded-lg border border-line bg-card"><table className="w-full text-left text-sm"><thead className="text-xs text-muted"><tr><th className="p-2">ID</th><th>Title</th><th>Severity</th><th>Status</th><th>Affected</th></tr></thead><tbody>{query.data.items.map((row) => <tr key={row.publicId} className="border-t border-line"><td className="p-2"><Link className="text-blue-700" to={`/incidents/${row.publicId}`}>{row.publicId}</Link></td><td>{row.title}</td><td><StatusBadge status={row.severity} /></td><td><StatusBadge status={row.status} /></td><td>{row.affectedTransactionCount}</td></tr>)}</tbody></table></div> : <EmptyState title="No incidents found." detail="Try changing the selected date range." />}
      <Pagination page={query.data?.page ?? 1} totalPages={query.data?.totalPages ?? 1} onPage={setPage} />
    </div>
  )
}

function CreateIncident({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState('MEDIUM')
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  return (
    <form className="mb-4 grid gap-3 rounded-lg border border-line bg-card p-4" onSubmit={async (event) => {
      event.preventDefault()
      setBusy(true)
      try {
        await api('/api/incidents', { method: 'POST', headers: { 'Idempotency-Key': `inc-${title}-${Date.now()}` }, body: JSON.stringify({ title, description, severity }) })
        onDone()
      } catch (error) { toast.push((error as { message: string }).message, 'err') } finally { setBusy(false) }
    }}>
      <input className={inputClass} placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} required />
      <textarea className={inputClass} placeholder="Description" value={description} onChange={(event) => setDescription(event.target.value)} required />
      <select className={inputClass} value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label="Severity">{['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((item) => <option key={item}>{item}</option>)}</select>
      <div className="flex gap-2"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button></div>
    </form>
  )
}

export function IncidentDetailPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const query = useQuery({ queryKey: ['incident', id], queryFn: () => api<{
    publicId: string; title: string; description: string; severity: string; status: string; aiSummary: string | null; aiLabel: string; rootCause: string | null; resolution: string | null; affectedTransactionCount: number; assignee: { id: string; name: string } | null; services: Array<{ name: string }>; institutions: Array<{ name: string }>; timeline: Array<{ id: string; message: string; timestamp: string; actorEmail: string | null }>
  }>(`/api/incidents/${id}`) })
  const engineers = useQuery({ queryKey: ['engineers'], enabled: Boolean(user && can(user.role, 'incidents:assign')), queryFn: () => api<Array<{ id: string; name: string }>>('/api/engineers') })
  if (query.isLoading) return <Skeleton className="h-80" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  const row = query.data!
  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    try {
      await api(`/api/incidents/${id}`, { method: 'PATCH', headers: { 'Idempotency-Key': `patch-${id}-${JSON.stringify(body)}-${Date.now()}` }, body: JSON.stringify(body) })
      toast.push('Incident updated')
      client.invalidateQueries({ queryKey: ['incident', id] })
    } catch (error) { toast.push((error as { message: string }).message, 'err') } finally { setBusy(false); setConfirm(false) }
  }
  const manage = user && can(user.role, 'incidents:manage')
  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
      <div>
        <Link to="/incidents" className="text-sm text-blue-700">All incidents</Link>
        <h1 className="mt-2 text-xl font-semibold">{row.publicId} · {row.title}</h1>
        <div className="mt-2 flex gap-2"><StatusBadge status={row.severity} /><StatusBadge status={row.status} /></div>
        <p className="mt-3 text-sm">{row.description}</p>
        <p className="mt-2 text-sm text-muted">Affected transactions {row.affectedTransactionCount}. Services: {row.services.map((item) => item.name).join(', ') || '—'}. Institutions: {row.institutions.map((item) => item.name).join(', ') || '—'}.</p>
        <Card className="mt-4" title="AI summary"><p className="whitespace-pre-wrap text-sm">{row.aiSummary}</p><p className="mt-2 text-xs text-amber-700">{row.aiLabel}</p></Card>
        {manage ? (
          <div className="mt-4 space-y-2">
            {user && can(user.role, 'incidents:assign') ? <select className={inputClass} aria-label="Assign engineer" defaultValue="" onChange={(event) => patch({ assigneeId: event.target.value })}><option value="" disabled>Assign engineer</option>{engineers.data?.map((engineer) => <option key={engineer.id} value={engineer.id}>{engineer.name}</option>)}</select> : null}
            <select className={inputClass} aria-label="Change status" value={row.status} onChange={(event) => { if (event.target.value === 'RESOLVED' && (row.severity === 'CRITICAL' || row.severity === 'HIGH')) setConfirm(true); else patch({ status: event.target.value }) }}>
              {['OPEN', 'INVESTIGATING', 'IDENTIFIED', 'MITIGATING', 'RESOLVED', 'CLOSED'].map((status) => <option key={status}>{status}</option>)}
            </select>
            <textarea className={inputClass} placeholder="Add note" value={note} onChange={(event) => setNote(event.target.value)} />
            <Button disabled={busy || !note} onClick={() => { patch({ note }); setNote('') }}>Add note</Button>
          </div>
        ) : null}
      </div>
      <Card title="Timeline"><ol className="space-y-3">{row.timeline.map((event) => <li key={event.id}><p className="text-xs text-muted">{new Date(event.timestamp).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', hour12: false })} · {event.actorEmail}</p><p className="text-sm">{event.message}</p></li>)}</ol></Card>
      {confirm ? <ConfirmDialog title="Resolve incident" body="Resolve this high-severity incident? The action is written to the audit log." confirmLabel="Resolve" danger busy={busy} onClose={() => setConfirm(false)} onConfirm={() => patch({ status: 'RESOLVED' })} /> : null}
    </div>
  )
}

export function InstitutionsPage() {
  const query = useQuery({ queryKey: ['institutions'], queryFn: () => api<Array<{ id: string; name: string; code: string; type: string; status: string; transactions: number; successRate: number; failureRate: number; avgResponseMs: number; value: number; lastIncident: { id: string; title: string } | null }>>('/api/institutions?range=30d') })
  if (query.isLoading) return <Skeleton className="h-64" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Institutions</h1>
      <p className="mb-3 text-sm text-muted">Fictional demo institutions. These are not real banks or F1Soft clients.</p>
      <div className="grid gap-3 md:grid-cols-2">{query.data?.map((row) => (
        <Link key={row.id} to={`/institutions/${row.id}`} className="rounded-lg border border-line bg-card p-4">
          <div className="flex justify-between"><h2 className="font-semibold">{row.name}</h2><StatusBadge status={row.status} /></div>
          <p className="mt-2 text-sm text-muted">{row.code} · {row.type} · {row.transactions.toLocaleString('en-US')} tx · {formatPercent(row.successRate)} success · {formatDuration(row.avgResponseMs)}</p>
          <p className="text-sm">{formatNpr(row.value)} · last incident {row.lastIncident?.id ?? 'none'}</p>
        </Link>
      ))}</div>
    </div>
  )
}

export function InstitutionDetailPage() {
  const { id = '' } = useParams()
  const query = useQuery({ queryKey: ['institution', id], queryFn: () => api<{ name: string; status: string; transactions: number; successRate: number; failures: number; avgResponseMs: number; apiAvailability: number; topFailure: string | null; value: number; failureReasons: Array<{ reason: string; count: number }>; volume: Array<{ time: string; success: number; failed: number }> }>(`/api/institutions/${id}?range=7d`) })
  if (query.isLoading) return <Skeleton className="h-64" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  const row = query.data!
  return (
    <div className="space-y-4">
      <Link to="/institutions" className="text-sm text-blue-700">All institutions</Link>
      <h1 className="text-xl font-semibold">{row.name}</h1>
      <StatusBadge status={row.status} />
      <div className="grid gap-3 sm:grid-cols-3 text-sm">
        <Card><p className="text-xs text-muted">Transactions</p><p className="text-xl font-semibold">{row.transactions.toLocaleString('en-US')}</p></Card>
        <Card><p className="text-xs text-muted">Success</p><p className="text-xl font-semibold">{formatPercent(row.successRate)}</p></Card>
        <Card><p className="text-xs text-muted">Failures / latency</p><p className="text-xl font-semibold">{row.failures.toLocaleString('en-US')} · {formatDuration(row.avgResponseMs)}</p></Card>
      </div>
      <Card title="Volume"><div className="h-56"><ResponsiveContainer width="100%" height="100%"><BarChart data={row.volume}><XAxis dataKey="time" hide /><YAxis /><Tooltip /><Bar dataKey="success" fill="#15803d" /><Bar dataKey="failed" fill="#b91c1c" /></BarChart></ResponsiveContainer></div></Card>
      <Card title="Failure reasons"><p className="mb-2 text-sm">Top failure: {row.topFailure ?? 'none'}. Value {formatNpr(row.value)}. API availability {formatPercent(row.apiAvailability)}.</p>{row.failureReasons.length ? <ul className="text-sm">{row.failureReasons.map((reason) => <li key={reason.reason}>{reason.reason} · {reason.count}</li>)}</ul> : <EmptyState title="No failures in this range." />}</Card>
    </div>
  )
}

export function AnomaliesPage() {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [page, setPage] = useState(1)
  const [pending, setPending] = useState<{ id: string; status: 'CONFIRMED' | 'DISMISSED' } | null>(null)
  const query = useQuery({ queryKey: ['anomalies', page], queryFn: () => api<{ items: Array<{ publicId: string; type: string; severity: string; status: string; score: number; title: string; description: string; method: string; institution: string | null; merchant: string | null }>; page: number; totalPages: number }>(`/api/anomalies?page=${page}&limit=25`) })
  if (query.isLoading) return <Skeleton className="h-64" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  return (
    <div>
      <h1 className="text-xl font-semibold">Anomalies</h1>
      <p className="mb-4 text-sm text-muted">Simulated anomaly detection. This is not a production fraud engine.</p>
      {query.data?.items.length ? <div className="grid gap-3">{query.data.items.map((row) => (
        <article key={row.publicId} className="rounded-lg border border-line bg-card p-4">
          <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{row.title}</h2><StatusBadge status={row.severity} /><StatusBadge status={row.status} /></div>
          <p className="mt-1 text-sm">{row.description}</p>
          <p className="mt-1 text-xs text-muted">{row.publicId} · {row.type} · method {row.method} · score {row.score.toFixed(2)} · {row.institution ?? row.merchant ?? 'platform'}</p>
          {user && can(user.role, 'anomalies:review') && row.status !== 'CONFIRMED' && row.status !== 'DISMISSED' ? <div className="mt-3 flex gap-2"><Button onClick={() => setPending({ id: row.publicId, status: 'CONFIRMED' })}>Confirm</Button><Button variant="ghost" onClick={() => setPending({ id: row.publicId, status: 'DISMISSED' })}>Dismiss</Button></div> : null}
        </article>
      ))}</div> : <EmptyState title="No anomalies found." />}
      <Pagination page={query.data?.page ?? 1} totalPages={query.data?.totalPages ?? 1} onPage={setPage} />
      {pending ? <ConfirmDialog title={pending.status === 'DISMISSED' ? 'Dismiss anomaly' : 'Confirm anomaly'} body="This decision is stored and written to the audit log." confirmLabel={pending.status === 'DISMISSED' ? 'Dismiss' : 'Confirm'} danger={pending.status === 'DISMISSED'} onClose={() => setPending(null)} onConfirm={async () => {
        await api(`/api/anomalies/${pending.id}`, { method: 'PATCH', body: JSON.stringify({ status: pending.status, note: 'Reviewed in the console.' }) })
        toast.push('Anomaly updated')
        setPending(null)
        client.invalidateQueries({ queryKey: ['anomalies'] })
      }} /> : null}
    </div>
  )
}
