import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { can } from '@finopsx/shared'
import { api, errorMessage } from '../api'
import { useAuth } from '../contexts'
import { axisTick, gridStroke, tooltipStyle } from '../lib/chart'
import { chartTick, fmtDateTime, fmtMs, fmtPct, humanize, relTime } from '../lib/format'
import { Badge, Card, EmptyState, ErrorState, PageHeader, Select, Skeleton, Stat, StatusBadge, Table } from '../components/ui'

type Service = { id: string; key: string; name: string; layer: string; description: string; status: string; telemetry: string; responseTimeMs: number | null; errorRate: number | null; uptime: number | null; endpoints: number; lastCheckedAt: string }
type InfraMetric = { key: string; label: string; unit: string; measured: boolean; note: string; value: number | null }
type Infra = { label: string; note: string; redis: string; metrics: InfraMetric[]; healthScore: number | null; recordedAt: string | null; history: Array<{ time: string; cpu: number; memory: number; processMemoryMb: number; eventLoopLagMs: number; dbConnections: number; queueLength: number; healthScore: number }> }
type ApiRow = { id: string; name: string; method: string; endpoint: string; key: string; demo: boolean; service: { name: string }; status: string; calls: number; rpm: number; successRate: number | null; errorRate: number | null; clientErrorRate: number | null; availability: number | null; avgLatencyMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null }

const TELEMETRY_LABEL: Record<string, string> = {
  'api-calls': 'Measured from API call logs',
  transactions: 'Measured from transaction outcomes',
  database: 'Measured from database probes',
  redis: 'Measured from Redis connection',
  none: 'No telemetry — status inferred from dependencies',
}

export function SystemHealthPage() {
  const { user } = useAuth()
  const [windowMinutes, setWindow] = useState('15')
  const [hours, setHours] = useState('6')
  const health = useQuery({ queryKey: ['system', 'health'], queryFn: () => api<{ services: Service[]; infrastructure: Infra }>('/api/system/health'), refetchInterval: 15_000 })
  const infra = useQuery({ queryKey: ['system', 'infrastructure', hours], queryFn: () => api<Infra>(`/api/system/infrastructure?hours=${hours}`), refetchInterval: 30_000 })
  const showApis = Boolean(user && can(user.role, 'apis:view'))
  const apis = useQuery({ queryKey: ['apis', windowMinutes], enabled: showApis, queryFn: () => api<{ windowMinutes: number; source: string; items: ApiRow[] }>(`/api/apis?window=${windowMinutes}`), refetchInterval: 15_000 })

  if (health.isLoading) return <Skeleton className="h-80" />
  if (health.isError) return <ErrorState onRetry={() => health.refetch()} message={errorMessage(health.error)} />
  const services = health.data!.services
  const counts = services.reduce<Record<string, number>>((acc, service) => ({ ...acc, [service.status]: (acc[service.status] ?? 0) + 1 }), {})
  const layers = [...new Set(services.map((service) => service.layer))]
  const infraData = infra.data ?? health.data!.infrastructure

  return (
    <div className="space-y-4">
      <PageHeader
        title="System Health"
        description="Service status is derived from telemetry every 10 seconds: API call logs, transaction outcomes and database probes. Nothing on this page is set by hand."
        actions={user && can(user.role, 'services:view') ? <Link className="text-sm text-brand" to="/service-map">Open service map →</Link> : null}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Operational" value={counts.OPERATIONAL ?? 0} tone="good" />
        <Stat label="Degraded" value={counts.DEGRADED ?? 0} tone={counts.DEGRADED ? 'warn' : undefined} />
        <Stat label="Incident / down" value={(counts.INCIDENT ?? 0) + (counts.DOWN ?? 0)} tone={(counts.INCIDENT ?? 0) + (counts.DOWN ?? 0) ? 'bad' : undefined} />
        <Stat label="Health score" value={infraData.healthScore != null ? `${Math.round(infraData.healthScore)}/100` : '—'} hint="Success rate, latency and service status over the last hour" />
      </div>

      {layers.map((layer) => (
        <Card key={layer} title={humanize(layer)}>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {services.filter((service) => service.layer === layer).map((service) => (
              <div key={service.id} className="rounded-2xl border border-line p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{service.name}</p>
                  <StatusBadge status={service.status} />
                </div>
                <p className="mt-1 text-xs text-muted">{service.description}</p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-muted">Response</dt><dd className="tabular-nums">{fmtMs(service.responseTimeMs)}</dd></div>
                  <div><dt className="text-muted">Errors</dt><dd className="tabular-nums">{fmtPct(service.errorRate)}</dd></div>
                  <div><dt className="text-muted">Uptime</dt><dd className="tabular-nums">{fmtPct(service.uptime, 2)}</dd></div>
                </dl>
                <p className="mt-2 text-[11px] text-muted">{TELEMETRY_LABEL[service.telemetry] ?? service.telemetry} · checked {relTime(service.lastCheckedAt)}</p>
              </div>
            ))}
          </div>
        </Card>
      ))}

      {showApis ? (
        <Card title="API observability" action={<Select label="Window" value={windowMinutes} onChange={setWindow} options={[['5', 'Last 5 min'], ['15', 'Last 15 min'], ['60', 'Last hour'], ['360', 'Last 6 hours']]} />}>
          <p className="mb-3 text-xs text-muted">Percentiles are computed with <code>percentile_cont</code> over individual API call records. Demo endpoints are synthetic routes exercised by the transaction simulator.</p>
          {apis.isLoading ? <Skeleton className="h-40" /> : apis.isError ? <ErrorState onRetry={() => apis.refetch()} message={errorMessage(apis.error)} /> : apis.data?.items.length ? (
            <Table head={['Endpoint', 'Service', 'Status', 'RPM', 'Availability', 'Errors', 'P50', 'P95', 'P99']} minWidth={900}>
              {apis.data.items.map((row) => (
                <tr key={row.id}>
                  <td><Link className="font-mono text-xs text-brand" to={`/system-health/apis/${row.id}`}>{row.key}</Link>{row.demo ? <span className="ml-2"><Badge tone="info">demo</Badge></span> : null}</td>
                  <td className="text-muted">{row.service.name}</td>
                  <td><StatusBadge status={row.status} /></td>
                  <td className="tabular-nums">{row.rpm.toFixed(1)}</td>
                  <td className="tabular-nums">{fmtPct(row.availability, 2)}</td>
                  <td className="tabular-nums">{fmtPct(row.errorRate)}</td>
                  <td className="tabular-nums">{fmtMs(row.p50Ms)}</td>
                  <td className="tabular-nums">{fmtMs(row.p95Ms)}</td>
                  <td className="tabular-nums">{fmtMs(row.p99Ms)}</td>
                </tr>
              ))}
            </Table>
          ) : <EmptyState title="No API calls in this window." detail="Start the demo simulator to generate traffic." />}
        </Card>
      ) : null}

      <Card title={infraData.label} action={<Select label="History" value={hours} onChange={setHours} options={[['1', '1 hour'], ['6', '6 hours'], ['24', '24 hours']]} />}>
        <p className="mb-3 text-xs text-muted">{infraData.note} Redis: {infraData.redis.toLowerCase()}. Last sample {fmtDateTime(infraData.recordedAt)}.</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {infraData.metrics.map((metric) => (
            <div key={metric.key} className="rounded-2xl border border-line p-3" title={metric.note}>
              <p className="flex items-center justify-between gap-2 text-xs text-muted">{metric.label}<Badge tone={metric.measured ? 'good' : 'neutral'}>{metric.measured ? 'measured' : 'simulated'}</Badge></p>
              <p className="mt-1 text-lg font-semibold tabular-nums">{metric.value == null ? '—' : `${Number(metric.value.toFixed(metric.unit === '%' ? 1 : 2))}${metric.unit ? ` ${metric.unit}` : ''}`}</p>
            </div>
          ))}
        </div>
        {infraData.history.length > 1 ? (
          <div className="mt-4 h-56" role="img" aria-label="CPU, memory and event loop lag over time">
            <ResponsiveContainer>
              <LineChart data={infraData.history}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                <XAxis dataKey="time" tickFormatter={(value) => chartTick(value)} tick={axisTick} minTickGap={40} />
                <YAxis tick={axisTick} width={36} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => fmtDateTime(String(value))} />
                <Line type="monotone" dataKey="cpu" name="CPU %" stroke="#2563eb" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="memory" name="Host memory %" stroke="#10b981" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="eventLoopLagMs" name="Event loop lag ms" stroke="#f59e0b" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : <p className="mt-3 text-sm text-muted">History builds up as samples are recorded every minute.</p>}
      </Card>
    </div>
  )
}

type ApiDetail = ApiRow & {
  windowMinutes: number
  thresholds: { availabilityPct: number; latencyMs: number }
  service: { id: string; key: string; name: string; status: string }
  series: Array<{ time: string; rpm: number; errorRate: number; avgLatencyMs: number; p95Ms: number }>
  statusCodes: Array<{ code: number; count: number; class: string }>
  institutions: Array<{ name: string; calls: number; errorRate: number; avgLatencyMs: number }>
  recentErrors: Array<{ statusCode: number; latencyMs: number; transactionRef: string | null; institution: string | null; at: string }>
}

export function ApiDetailPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const [windowMinutes, setWindow] = useState('60')
  const query = useQuery({ queryKey: ['apis', id, windowMinutes], queryFn: () => api<ApiDetail>(`/api/apis/${id}?window=${windowMinutes}`), refetchInterval: 15_000 })
  if (query.isLoading) return <Skeleton className="h-80" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} />
  const row = query.data!
  const canTx = Boolean(user && can(user.role, 'transactions:view'))
  return (
    <div className="space-y-4">
      <Link to="/system-health" className="text-sm text-brand">← System Health</Link>
      <PageHeader
        title={row.key}
        description={<>{row.name} · {row.service.name} · thresholds: availability ≥ {row.thresholds.availabilityPct}%, P95 ≤ {fmtMs(row.thresholds.latencyMs)}{row.demo ? ' · demo endpoint' : ''}</>}
        actions={<div className="flex items-center gap-2"><StatusBadge status={row.status} /><Select label="Window" value={windowMinutes} onChange={setWindow} options={[['15', '15 min'], ['60', '1 hour'], ['360', '6 hours']]} /></div>}
      />
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Requests / min" value={row.rpm.toFixed(1)} hint={`${row.calls} calls`} />
        <Stat label="Availability" value={fmtPct(row.availability, 2)} tone={row.availability != null && row.availability < row.thresholds.availabilityPct ? 'bad' : 'good'} />
        <Stat label="Server errors" value={fmtPct(row.errorRate)} hint={`client errors ${fmtPct(row.clientErrorRate)}`} />
        <Stat label="P50" value={fmtMs(row.p50Ms)} />
        <Stat label="P95" value={fmtMs(row.p95Ms)} tone={row.p95Ms != null && row.p95Ms > row.thresholds.latencyMs ? 'warn' : undefined} />
        <Stat label="P99" value={fmtMs(row.p99Ms)} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Latency (per minute)">
          {row.series.length ? (
            <div className="h-56" role="img" aria-label="Average and P95 latency per minute">
              <ResponsiveContainer>
                <LineChart data={row.series}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                  <XAxis dataKey="time" tickFormatter={(value) => chartTick(value)} tick={axisTick} minTickGap={40} />
                  <YAxis tick={axisTick} width={44} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => fmtDateTime(String(value))} />
                  <Line type="monotone" dataKey="avgLatencyMs" name="Average ms" stroke="#2563eb" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="p95Ms" name="P95 ms" stroke="#f59e0b" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState title="No calls in this window." />}
        </Card>
        <Card title="Throughput and errors (per minute)">
          {row.series.length ? (
            <div className="h-56" role="img" aria-label="Requests and error rate per minute">
              <ResponsiveContainer>
                <LineChart data={row.series}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                  <XAxis dataKey="time" tickFormatter={(value) => chartTick(value)} tick={axisTick} minTickGap={40} />
                  <YAxis yAxisId="rpm" tick={axisTick} width={36} />
                  <YAxis yAxisId="err" orientation="right" tick={axisTick} width={36} unit="%" />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => fmtDateTime(String(value))} />
                  <Line yAxisId="rpm" type="monotone" dataKey="rpm" name="Requests" stroke="#10b981" dot={false} strokeWidth={2} />
                  <Line yAxisId="err" type="monotone" dataKey="errorRate" name="Error %" stroke="#ef4444" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState title="No calls in this window." />}
        </Card>
        <Card title="Status codes">
          {row.statusCodes.length ? (
            <div className="h-48">
              <ResponsiveContainer>
                <BarChart data={row.statusCodes.map((item) => ({ ...item, label: String(item.code) }))}>
                  <XAxis dataKey="label" tick={axisTick} />
                  <YAxis tick={axisTick} width={40} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name="Calls" fill="#2563eb" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState title="No calls in this window." />}
        </Card>
        <Card title="By institution">
          {row.institutions.length ? (
            <Table head={['Institution', 'Calls', 'Error rate', 'Avg latency']} minWidth={400}>
              {row.institutions.map((item) => (
                <tr key={item.name}><td>{item.name}</td><td className="tabular-nums">{item.calls}</td><td className="tabular-nums">{fmtPct(item.errorRate)}</td><td className="tabular-nums">{fmtMs(item.avgLatencyMs)}</td></tr>
              ))}
            </Table>
          ) : <EmptyState title="No calls in this window." />}
        </Card>
      </div>
      <Card title="Recent errors (4xx/5xx)">
        {row.recentErrors.length ? (
          <Table head={['Time', 'Status', 'Latency', 'Institution', 'Transaction']} minWidth={560}>
            {row.recentErrors.map((item, index) => (
              <tr key={`${item.at}-${index}`}>
                <td className="text-muted">{fmtDateTime(item.at)}</td>
                <td><Badge tone={item.statusCode >= 500 ? 'bad' : 'warn'}>{item.statusCode}</Badge></td>
                <td className="tabular-nums">{fmtMs(item.latencyMs)}</td>
                <td>{item.institution ?? '—'}</td>
                <td>{item.transactionRef ? canTx ? <Link className="text-brand" to={`/transactions/${item.transactionRef}`}>{item.transactionRef}</Link> : item.transactionRef : '—'}</td>
              </tr>
            ))}
          </Table>
        ) : <p className="text-sm text-muted">No errors in this window.</p>}
      </Card>
    </div>
  )
}
