import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Circle, Loader2, Pause, Play, RotateCcw, Zap } from 'lucide-react'
import { can, formatNpr, SCENARIO_LABEL, SCENARIOS, type Scenario } from '@finopsx/shared'
import { api, errorMessage, idem } from '../api'
import { useAuth, useToast } from '../contexts'
import { useRealtime } from '../realtime'
import { fmtDateTime, fmtMs, fmtPct, humanize, relTime, useUrlFilters } from '../lib/format'
import { Badge, Button, Card, ConfirmDialog, ErrorState, Field, inputClass, PageHeader, Skeleton, Stat, StatusBadge } from '../components/ui'

/* -------------------------------------------------------------- Service map */

type MapNode = {
  id: string
  key: string
  name: string
  layer: string
  description: string
  status: string
  responseTimeMs: number | null
  errorRate: number | null
  uptime: number | null
  endpoints: Array<{ id: string; key: string; status: string; p95Ms: number | null; availability: number | null }>
  impactedBy: string[]
  activeIncidents: Array<{ id: string; title: string; severity: string }>
  dependsOn: string[]
  dependents: string[]
}

const STATUS_FILL: Record<string, { fill: string; stroke: string }> = {
  OPERATIONAL: { fill: '#ecfdf5', stroke: '#10b981' },
  DEGRADED: { fill: '#fffbeb', stroke: '#f59e0b' },
  INCIDENT: { fill: '#fef2f2', stroke: '#ef4444' },
  DOWN: { fill: '#fef2f2', stroke: '#b91c1c' },
  MAINTENANCE: { fill: '#eff6ff', stroke: '#3b82f6' },
}

const NODE_W = 176
const NODE_H = 56
const WIDTH = 1040
const ROW_H = 150

export function ServiceMapPage() {
  const [filters, setFilters] = useUrlFilters({ focus: '' })
  const query = useQuery({ queryKey: ['service-map'], queryFn: () => api<{ title: string; note: string; layers: string[]; nodes: MapNode[]; edges: Array<{ from: string; to: string; degraded: boolean }> }>('/api/services/map'), refetchInterval: 15_000 })

  const layout = useMemo(() => {
    if (!query.data) return null
    const positions = new Map<string, { x: number; y: number }>()
    query.data.layers.forEach((layer, row) => {
      const nodes = query.data.nodes.filter((node) => node.layer === layer).sort((a, b) => a.name.localeCompare(b.name))
      const gap = WIDTH / (nodes.length + 1)
      nodes.forEach((node, index) => positions.set(node.id, { x: gap * (index + 1) - NODE_W / 2, y: 40 + row * ROW_H }))
    })
    return { positions, height: 40 + query.data.layers.length * ROW_H }
  }, [query.data])

  if (query.isLoading) return <Skeleton className="h-96" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} />
  const data = query.data!
  const focus = data.nodes.find((node) => node.key === filters.focus || node.id === filters.focus) ?? null
  const related = new Set(focus ? [focus.id, ...focus.dependsOn, ...focus.dependents] : [])
  const nameOf = (id: string) => data.nodes.find((node) => node.id === id)?.name ?? id
  const impacted = data.nodes.filter((node) => node.status !== 'OPERATIONAL' || node.impactedBy.length)

  return (
    <div className="space-y-4">
      <PageHeader title={data.title} description={data.note} />
      {impacted.length ? (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100" role="status">
          {data.nodes.filter((node) => node.status !== 'OPERATIONAL').map((node) => node.name).join(', ') || 'No service'} {data.nodes.some((node) => node.status !== 'OPERATIONAL') ? 'is not operational.' : ''}{' '}
          {data.nodes.some((node) => node.impactedBy.length) ? `Upstream callers that may be affected: ${data.nodes.filter((node) => node.impactedBy.length).map((node) => node.name).join(', ')}.` : ''}
        </div>
      ) : <p className="text-sm text-emerald-700 dark:text-emerald-300">All services are operational.</p>}
      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${WIDTH} ${layout!.height}`} className="min-w-[760px]" role="img" aria-label="Service dependency graph">
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#94a3b8" /></marker>
                <marker id="arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#ef4444" /></marker>
              </defs>
              {data.layers.map((layer, row) => (
                <text key={layer} x={8} y={30 + row * ROW_H} fontSize="11" fill="var(--muted)" fontWeight={600}>{humanize(layer).toUpperCase()}</text>
              ))}
              {data.edges.map((edge) => {
                const from = layout!.positions.get(edge.from)
                const to = layout!.positions.get(edge.to)
                if (!from || !to) return null
                const x1 = from.x + NODE_W / 2
                const x2 = to.x + NODE_W / 2
                const down = to.y > from.y
                const y1 = down ? from.y + NODE_H : from.y + NODE_H / 2
                const y2 = down ? to.y : to.y + NODE_H / 2
                const mid = (y1 + y2) / 2
                const dim = focus && !(related.has(edge.from) && related.has(edge.to) && (edge.from === focus.id || edge.to === focus.id))
                return (
                  <path
                    key={`${edge.from}-${edge.to}`}
                    d={down ? `M${x1} ${y1} C${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}` : `M${x1} ${y1} L${x2 + (x2 > x1 ? -NODE_W / 2 : NODE_W / 2)} ${y2}`}
                    fill="none"
                    stroke={edge.degraded ? '#ef4444' : '#94a3b8'}
                    strokeWidth={edge.degraded ? 2.2 : 1.4}
                    strokeDasharray={edge.degraded ? '6 4' : undefined}
                    markerEnd={edge.degraded ? 'url(#arrow-bad)' : 'url(#arrow)'}
                    opacity={dim ? 0.15 : 0.9}
                  />
                )
              })}
              {data.nodes.map((node) => {
                const pos = layout!.positions.get(node.id)
                if (!pos) return null
                const colors = STATUS_FILL[node.status] ?? STATUS_FILL.OPERATIONAL
                const dim = focus && !related.has(node.id)
                const selected = focus?.id === node.id
                return (
                  <g
                    key={node.id}
                    transform={`translate(${pos.x} ${pos.y})`}
                    className="cursor-pointer"
                    opacity={dim ? 0.3 : 1}
                    role="button"
                    tabIndex={0}
                    aria-label={`${node.name}: ${humanize(node.status)}`}
                    onClick={() => setFilters({ focus: selected ? '' : node.key })}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setFilters({ focus: selected ? '' : node.key }) } }}
                  >
                    <rect width={NODE_W} height={NODE_H} rx={14} fill={colors.fill} stroke={selected ? '#2f6bff' : colors.stroke} strokeWidth={selected ? 3 : 1.6} />
                    <circle cx={14} cy={18} r={5} fill={colors.stroke} />
                    <text x={26} y={22} fontSize="12.5" fontWeight={600} fill="#0f172a">{node.name.length > 21 ? `${node.name.slice(0, 20)}…` : node.name}</text>
                    <text x={14} y={42} fontSize="10.5" fill="#475569">{humanize(node.status)}{node.responseTimeMs != null ? ` · ${fmtMs(node.responseTimeMs)}` : ''}{node.activeIncidents.length ? ` · ${node.activeIncidents.length} incident` : ''}</text>
                  </g>
                )
              })}
            </svg>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
            {Object.entries(STATUS_FILL).map(([status, colors]) => <span key={status} className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colors.stroke }} />{humanize(status)}</span>)}
            <span>Dashed red arrow: the called service is not operational.</span>
          </div>
        </Card>
        <Card title={focus ? focus.name : 'Service details'}>
          {focus ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2"><StatusBadge status={focus.status} /><span className="text-xs text-muted">{humanize(focus.layer)} layer</span></div>
              <p className="text-muted">{focus.description}</p>
              <dl className="grid grid-cols-3 gap-2 text-xs">
                <div><dt className="text-muted">Response</dt><dd>{fmtMs(focus.responseTimeMs)}</dd></div>
                <div><dt className="text-muted">Errors</dt><dd>{fmtPct(focus.errorRate)}</dd></div>
                <div><dt className="text-muted">Uptime</dt><dd>{fmtPct(focus.uptime, 2)}</dd></div>
              </dl>
              <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Depends on</p><p>{focus.dependsOn.map(nameOf).join(', ') || '—'}</p></div>
              <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Called by</p><p>{focus.dependents.map(nameOf).join(', ') || '—'}</p></div>
              {focus.impactedBy.length ? <p className="rounded-xl bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">May be affected by: {focus.impactedBy.join(', ')}</p> : null}
              {focus.activeIncidents.length ? (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Active incidents</p>
                  <ul>{focus.activeIncidents.map((incident) => <li key={incident.id}><Link className="text-brand" to={`/incidents/${incident.id}`}>{incident.id}</Link> {incident.title} <StatusBadge status={incident.severity} /></li>)}</ul>
                </div>
              ) : null}
              {focus.endpoints.length ? (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">API endpoints</p>
                  <ul className="space-y-1">{focus.endpoints.map((endpoint) => <li key={endpoint.id} className="flex items-center justify-between gap-2"><Link className="font-mono text-xs text-brand" to={`/system-health/apis/${endpoint.id}`}>{endpoint.key}</Link><StatusBadge status={endpoint.status} /></li>)}</ul>
                </div>
              ) : null}
            </div>
          ) : <p className="text-sm text-muted">Select a service to see its dependencies, endpoints and incidents.</p>}
        </Card>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- Demo simulator */

type SimStatus = { running: boolean; tpm: number; successRate: number; failureRate: number; pendingRate: number; highValueRate: number; anomalyRate: number; averageAmount: number; scenario: Scenario | null; scenarioLabel: string | null; scenarioIntensity: number; scenarioStartedAt: string | null; generatedLastMinute: number; warning: string }

const SCENARIO_INFO: Record<Scenario, { service: string; serviceName: string; effect: string; anomalyTypes: string[]; anomalyMatch?: RegExp }> = {
  BANK_API_LATENCY: { service: 'bank-api', serviceName: 'Bank API', effect: 'Demo Bank B responses slow to several seconds and timeouts rise.', anomalyTypes: ['API_LATENCY_SPIKE', 'FAILURE_RATE_SPIKE', 'REPEATED_FAILURE'], anomalyMatch: /Demo Bank B|bank/i },
  PAYMENT_FAILURE_SPIKE: { service: 'payment-api', serviceName: 'Payment API', effect: 'Payment failures jump across institutions.', anomalyTypes: ['FAILURE_RATE_SPIKE', 'REPEATED_FAILURE'] },
  SETTLEMENT_DELAY: { service: 'settlement-service', serviceName: 'Settlement Service', effect: 'Settlement batches stall and successful payments remain unsettled.', anomalyTypes: ['SETTLEMENT_DELAY'] },
  HIGH_VOLUME: { service: 'payment-gateway', serviceName: 'Payment Gateway', effect: 'Transactions per minute surge well above the configured baseline.', anomalyTypes: ['TRANSACTION_VOLUME_SPIKE', 'INSTITUTION_ACTIVITY'] },
  MERCHANT_ACTIVITY: { service: 'merchant-api', serviceName: 'Merchant API', effect: 'One merchant receives an unusual burst of high-value payments.', anomalyTypes: ['MERCHANT_VOLUME_SPIKE', 'HIGH_VALUE_SPIKE'] },
  NOTIFICATION_DEGRADATION: { service: 'notification-service', serviceName: 'Notification Service', effect: 'Payment notifications slow down and fail intermittently.', anomalyTypes: ['API_LATENCY_SPIKE', 'FAILURE_RATE_SPIKE'], anomalyMatch: /notify/i },
}

type Run = { scenario: Scenario; startedAt: string; endedAt?: string }
const RUN_KEY = 'finopsx.simulator.run'

export function DemoSimulatorPage() {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const { snapshot } = useRealtime()
  const [busy, setBusy] = useState<string | null>(null)
  const [intensity, setIntensity] = useState('1')
  const [confirmReset, setConfirmReset] = useState(false)
  const [run, setRun] = useState<Run | null>(() => {
    try { return JSON.parse(sessionStorage.getItem(RUN_KEY) ?? 'null') as Run | null } catch { return null }
  })
  const status = useQuery({ queryKey: ['simulator', 'status'], queryFn: () => api<SimStatus>('/api/simulator/status'), refetchInterval: 5000 })
  const [config, setConfig] = useState<Partial<SimStatus> | null>(null)

  useEffect(() => {
    const data = status.data
    if (!data) return
    if (data.scenario && data.scenarioStartedAt && (run?.scenario !== data.scenario || run.startedAt !== data.scenarioStartedAt)) {
      setRun({ scenario: data.scenario, startedAt: data.scenarioStartedAt })
    } else if (!data.scenario && run && !run.endedAt) {
      setRun({ ...run, endedAt: new Date().toISOString() })
    }
  }, [status.data, run])
  useEffect(() => {
    if (run) sessionStorage.setItem(RUN_KEY, JSON.stringify(run))
    else sessionStorage.removeItem(RUN_KEY)
  }, [run])

  async function call(label: string, path: string, body?: unknown) {
    setBusy(label)
    try {
      const next = await api<SimStatus>(`/api/simulator/${path}`, { method: path === 'config' ? 'PATCH' : 'POST', headers: path === 'scenario' ? idem('scenario') : undefined, body: JSON.stringify(body ?? {}) })
      client.setQueryData(['simulator', 'status'], next)
      client.invalidateQueries({ queryKey: ['dashboard'] })
      return next
    } catch (error) {
      toast.push(errorMessage(error), 'err')
      return null
    } finally { setBusy(null) }
  }

  if (!user || !can(user.role, 'simulator:control')) return <ErrorState message="Only Super Admins and Engineers can control the demo simulator." />
  if (status.isLoading) return <Skeleton className="h-96" />
  if (status.isError) return <ErrorState onRetry={() => status.refetch()} message={errorMessage(status.error)} />
  const s = status.data!
  const draft = { ...s, ...config }
  const invalid = (draft.failureRate ?? 0) + (draft.pendingRate ?? 0) > 0.95

  return (
    <div className="space-y-4">
      <PageHeader
        title="Demo Simulator"
        description="Generates synthetic payments and injects operational scenarios so you can watch the platform detect, explain and resolve them. Every control action is audited."
        actions={<Badge tone="warn">Synthetic data only</Badge>}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Simulator" value={<Badge tone={s.running ? (s.scenario ? 'warn' : 'good') : 'neutral'}>{s.running ? 'RUNNING' : 'STOPPED'}</Badge>} hint={s.scenarioLabel ? `Scenario: ${s.scenarioLabel}` : 'No scenario running'} />
        <Stat label="Generated last minute" value={s.generatedLastMinute.toLocaleString('en-US')} hint={`Target ${s.tpm} per minute`} />
        <Stat label="5-min failure rate" value={snapshot ? fmtPct(snapshot.window5m.failureRate) : '—'} tone={snapshot && snapshot.window5m.failureRate >= 10 ? 'bad' : undefined} />
        <Stat label="5-min avg latency" value={snapshot ? fmtMs(snapshot.window5m.avgLatencyMs) : '—'} />
        <Stat label="Degraded services" value={snapshot?.degradedServices.length ?? '—'} hint={snapshot?.degradedServices.map((item) => item.name).join(', ') || undefined} tone={snapshot?.degradedServices.length ? 'warn' : undefined} />
      </div>

      <Card title="Controls">
        <div className="flex flex-wrap gap-2">
          {s.running
            ? <Button variant="ghost" disabled={busy !== null} onClick={async () => { if (await call('stop', 'stop')) toast.push('Simulator stopped') }}><Pause className="mr-1 inline h-4 w-4" />Stop</Button>
            : <Button disabled={busy !== null} onClick={async () => { if (await call('start', 'start')) toast.push('Simulator started') }}><Play className="mr-1 inline h-4 w-4" />Start</Button>}
          <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmReset(true)}><RotateCcw className="mr-1 inline h-4 w-4" />Reset to defaults</Button>
        </div>
        <p className="mt-2 text-xs text-muted">{s.warning}</p>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Scenarios">
          <div className="mb-3 flex items-center gap-2 text-sm">
            <label htmlFor="intensity" className="text-muted">Intensity</label>
            <select id="intensity" className="rounded-full border border-line bg-card px-3 py-1 text-sm" value={intensity} onChange={(event) => setIntensity(event.target.value)}>
              {[['0.5', 'Mild'], ['1', 'Normal'], ['1.5', 'Strong'], ['2', 'Severe']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {SCENARIOS.map((name) => {
              const active = s.scenario === name
              return (
                <div key={name} className={`rounded-2xl border p-3 ${active ? 'border-brand bg-blue-50/60 dark:bg-blue-950/30' : 'border-line'}`}>
                  <p className="flex items-center gap-1.5 font-medium"><Zap className="h-4 w-4 text-brand" aria-hidden />{SCENARIO_LABEL[name]}</p>
                  <p className="mt-1 text-xs text-muted">{SCENARIO_INFO[name].effect}</p>
                  <p className="mt-1 text-[11px] text-muted">Target: {SCENARIO_INFO[name].serviceName}</p>
                  <div className="mt-2">
                    {active
                      ? <Button disabled={busy !== null} onClick={async () => { if (await call('resolve', 'scenario/resolve')) toast.push('Scenario resolved; metrics will recover') }}>Resolve scenario</Button>
                      : <Button variant="ghost" disabled={busy !== null || Boolean(s.scenario)} onClick={async () => { if (await call(name, 'scenario', { name, intensity: Number(intensity) })) toast.push(`${SCENARIO_LABEL[name]} started`) }}>{busy === name ? 'Starting…' : 'Trigger'}</Button>}
                  </div>
                </div>
              )
            })}
          </div>
          {s.scenario ? <p className="mt-2 text-xs text-muted">Only one scenario can run at a time. Resolve the current one to trigger another.</p> : null}
        </Card>

        <ChainReaction run={run} status={s} onClear={() => setRun(null)} />
      </div>

      <Card title="Traffic configuration">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Slider label="Transactions per minute" value={draft.tpm ?? 60} min={1} max={600} step={1} format={(value) => String(value)} onChange={(tpm) => setConfig((current) => ({ ...current, tpm }))} />
          <Slider label="Failure rate" value={draft.failureRate ?? 0} min={0} max={0.6} step={0.01} format={(value) => fmtPct(value * 100)} onChange={(failureRate) => setConfig((current) => ({ ...current, failureRate }))} />
          <Slider label="Pending rate" value={draft.pendingRate ?? 0} min={0} max={0.4} step={0.01} format={(value) => fmtPct(value * 100)} onChange={(pendingRate) => setConfig((current) => ({ ...current, pendingRate }))} />
          <Slider label="High-value rate" value={draft.highValueRate ?? 0} min={0} max={0.5} step={0.005} format={(value) => fmtPct(value * 100)} onChange={(highValueRate) => setConfig((current) => ({ ...current, highValueRate }))} />
          <Slider label="Anomaly injection rate" value={draft.anomalyRate ?? 0} min={0} max={0.2} step={0.005} format={(value) => fmtPct(value * 100)} onChange={(anomalyRate) => setConfig((current) => ({ ...current, anomalyRate }))} />
          <Field label="Average amount (NPR)"><input type="number" min={50} max={1_000_000} className={inputClass} value={draft.averageAmount ?? 0} onChange={(event) => setConfig((current) => ({ ...current, averageAmount: Number(event.target.value) }))} /></Field>
        </div>
        <p className="mt-3 text-sm">Resulting success rate: <strong>{fmtPct((1 - (draft.failureRate ?? 0) - (draft.pendingRate ?? 0)) * 100)}</strong> · average {formatNpr(draft.averageAmount ?? 0)}</p>
        {invalid ? <p className="mt-1 text-sm text-red-700 dark:text-red-300" role="alert">Failure and pending rates together must stay below 95%.</p> : null}
        <div className="mt-3 flex gap-2">
          <Button disabled={!config || invalid || busy !== null} onClick={async () => {
            if (!config) return
            const body = Object.fromEntries(Object.entries(config).filter(([key]) => ['tpm', 'failureRate', 'pendingRate', 'highValueRate', 'anomalyRate', 'averageAmount'].includes(key)))
            if (await call('config', 'config', body)) { setConfig(null); toast.push('Configuration saved') }
          }}>Save configuration</Button>
          {config ? <Button variant="ghost" onClick={() => setConfig(null)}>Discard changes</Button> : null}
        </div>
      </Card>

      {confirmReset ? <ConfirmDialog title="Reset simulator" body="Restore default traffic settings and end any running scenario? Existing synthetic data is kept." confirmLabel="Reset" busy={busy === 'reset'} onClose={() => setConfirmReset(false)} onConfirm={async () => { if (await call('reset', 'reset')) toast.push('Simulator reset'); setConfirmReset(false) }} /> : null}
    </div>
  )
}

function Slider({ label, value, min, max, step, format, onChange }: { label: string; value: number; min: number; max: number; step: number; format: (value: number) => string; onChange: (value: number) => void }) {
  const id = `slider-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <div>
      <label htmlFor={id} className="flex justify-between text-xs font-medium text-muted"><span>{label}</span><span className="tabular-nums text-ink">{format(value)}</span></label>
      <input id={id} type="range" className="mt-2 w-full accent-[#2f6bff]" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  )
}

type Step = { key: string; label: string; done: boolean; at?: string | null; detail?: ReactNode }

function ChainReaction({ run, status, onClear }: { run: Run | null; status: SimStatus; onClear: () => void }) {
  const { user } = useAuth()
  const { snapshot } = useRealtime()
  const active = Boolean(run && !run.endedAt)
  const since = run ? new Date(new Date(run.startedAt).getTime() - 30_000).getTime() : 0
  const poll = active ? 3000 : false
  const canIncidents = Boolean(user && can(user.role, 'incidents:view'))
  const canAnomalies = Boolean(user && can(user.role, 'anomalies:view'))
  const incidents = useQuery({
    queryKey: ['incidents', 'chain', run?.startedAt],
    enabled: Boolean(run) && canIncidents,
    refetchInterval: poll,
    queryFn: () => api<{ items: Array<{ publicId: string; title: string; status: string; severity: string; scenario: string | null; detectedAt: string; resolvedAt: string | null }> }>('/api/incidents?limit=20'),
  })
  const incident = incidents.data?.items.find((row) => row.scenario === run?.scenario && new Date(row.detectedAt).getTime() >= since) ?? null
  const detail = useQuery({
    queryKey: ['incident', incident?.publicId, 'chain'],
    enabled: Boolean(incident),
    refetchInterval: poll,
    queryFn: () => api<{ rca: { likelyCause: string | null; confidenceLabel: string } | null; status: string; anomalies: Array<{ publicId: string; title: string; type: string; detectedAt: string }> }>(`/api/incidents/${incident!.publicId}`),
  })
  const anomalies = useQuery({
    queryKey: ['anomalies', 'chain', run?.startedAt],
    enabled: Boolean(run) && canAnomalies,
    refetchInterval: poll,
    queryFn: () => api<{ items: Array<{ publicId: string; title: string; detectedAt: string; type: string; entityName: string | null }> }>('/api/anomalies?limit=50'),
  })
  const notifications = useQuery({
    queryKey: ['notifications', 'chain', run?.startedAt],
    enabled: Boolean(run),
    refetchInterval: poll,
    queryFn: () => api<{ items: Array<{ id: string; title: string; createdAt: string; link: string | null }> }>('/api/notifications?limit=50'),
  })

  if (!run) {
    return (
      <Card title="Chain reaction">
        <p className="text-sm text-muted">Trigger a scenario to watch each step happen in real time: affected traffic, a degraded service, a detected anomaly, an automatic incident, a notification, AI root cause analysis and resolution.</p>
      </Card>
    )
  }

  const info = SCENARIO_INFO[run.scenario]
  const relevant = (row: { type: string; title: string; entityName?: string | null }) => info.anomalyTypes.includes(row.type) && (!info.anomalyMatch || info.anomalyMatch.test(`${row.title} ${row.entityName ?? ''}`))
  const anomaly = anomalies.data?.items.filter((row) => relevant(row) && new Date(row.detectedAt).getTime() >= since).at(-1)
    ?? detail.data?.anomalies.filter(relevant).at(-1)
    ?? null
  const notification = incident ? notifications.data?.items.filter((row) => row.link === `/incidents/${incident.publicId}`).at(-1) ?? null : null
  const degraded = snapshot?.degradedServices.find((item) => item.key === info.service) ?? null
  const resolved = Boolean(run.endedAt) || incident?.status === 'RESOLVED' || incident?.status === 'POST_INCIDENT_REVIEW'
  const sawDegraded = Boolean(degraded) || Boolean(incident) || resolved
  const steps: Step[] = [
    { key: 'start', label: `${SCENARIO_LABEL[run.scenario]} started`, done: true, at: run.startedAt },
    { key: 'traffic', label: 'Synthetic traffic affected', done: Boolean(snapshot && new Date(snapshot.at).getTime() > new Date(run.startedAt).getTime()) || resolved, detail: snapshot ? <>5-min failure rate {fmtPct(snapshot.window5m.failureRate)}, avg latency {fmtMs(snapshot.window5m.avgLatencyMs)}</> : null },
    { key: 'service', label: `${info.serviceName} degraded`, done: sawDegraded, detail: degraded ? <>Status: {humanize(degraded.status)} · <Link className="text-brand" to={`/service-map?focus=${info.service}`}>service map</Link></> : sawDegraded ? 'Detected from telemetry' : 'Waiting for the health check (every 10s)…' },
    { key: 'anomaly', label: 'Anomaly detected', done: Boolean(anomaly), at: anomaly?.detectedAt, detail: anomaly ? <Link className="text-brand" to={`/anomalies?focus=${anomaly.publicId}`}>{anomaly.publicId} · {anomaly.title}</Link> : canAnomalies ? 'Waiting for the detector baseline to diverge…' : 'Your role cannot view anomalies.' },
    { key: 'incident', label: 'Incident created automatically', done: Boolean(incident), at: incident?.detectedAt, detail: incident ? <Link className="text-brand" to={`/incidents/${incident.publicId}`}>{incident.publicId} · {incident.title}</Link> : 'Incident rules need consecutive breaches before opening an incident…' },
    { key: 'notify', label: 'Team notified', done: Boolean(notification), at: notification?.createdAt, detail: notification ? notification.link ? <Link className="text-brand" to={notification.link}>{notification.title}</Link> : notification.title : 'Notifications follow incident creation.' },
    { key: 'rca', label: 'AI root cause analysis ready', done: Boolean(detail.data?.rca?.likelyCause), detail: detail.data?.rca?.likelyCause ? <>Likely cause ({detail.data.rca.confidenceLabel}): {detail.data.rca.likelyCause}</> : incident ? 'Collecting evidence…' : null },
    { key: 'resolve', label: 'Resolved and recovered', done: resolved, at: run.endedAt ?? incident?.resolvedAt, detail: resolved ? 'Scenario ended; metrics return to baseline over the next minutes.' : status.scenario ? 'Resolve the incident or the scenario to finish.' : null },
  ]
  const current = steps.findIndex((step) => !step.done)
  return (
    <Card title="Chain reaction" action={!active ? <Button variant="quiet" onClick={onClear}>Clear</Button> : <Badge tone="info">live</Badge>}>
      <p className="mb-3 text-xs text-muted">Started {fmtDateTime(run.startedAt)} ({relTime(run.startedAt)}). Each step is read from live platform data, not scripted.</p>
      <ol className="space-y-3" aria-live="polite">
        {steps.map((step, index) => (
          <li key={step.key} className="flex gap-3">
            {step.done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-label="done" /> : index === current && active ? <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-brand" aria-label="in progress" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" aria-label="pending" />}
            <div className="min-w-0 text-sm">
              <p className={step.done ? 'font-medium' : 'text-muted'}>{step.label}{step.at ? <span className="ml-2 text-[11px] font-normal text-muted">{fmtDateTime(step.at)}</span> : null}</p>
              {step.detail ? <p className="text-xs text-muted">{step.detail}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}
