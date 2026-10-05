import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { can, formatCount, formatNpr, PAYMENT_LABEL, type PaymentMethod } from '@finopsx/shared'
import { api, errorMessage } from '../api'
import { useAuth } from '../contexts'
import { useRealtime } from '../realtime'
import { chartTick, fmtMs, fmtPct, relTime } from '../lib/format'
import { Card, EmptyState, ErrorState, Select, Skeleton, StatusBadge, Table } from '../components/ui'

const RANGES: Array<[string, string]> = [['1h', 'Last hour'], ['6h', 'Last 6 hours'], ['24h', 'Last 24 hours'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']]

type Overview = {
  range: { from: string; to: string; label: string; unit: string }
  systemStatus: string
  kpis: { total: number; successful: number; failed: number; pending: number; successRate: number; failureRate: number; value: number; activeIncidents: number; apiAvailability: number | null; apiCallsLastHour: number; avgResponseMs: number; p95Ms: number; openAnomalies: number }
  volume: Array<{ time: string; success: number; failed: number; pending: number; other: number; value: number }>
  outcomes: Array<{ name: string; value: number }>
  paymentMethods: Array<{ method: PaymentMethod; count: number; value: number }>
  services: Array<{ id: string; key: string; name: string; status: string; responseTimeMs: number | null; uptime: number | null; errorRate: number | null; lastCheckedAt: string }>
  aiAlerts: Array<{ id: string; tone: string; message: string; href: string }>
  activeIncidents: Array<{ id: string; title: string; severity: string; status: string; createdAt: string; assignee: string | null; services: string[] }>
  institutions: Array<{ id: string; name: string; code: string; status: string; transactions: number; successRate: number; failureRate: number; avgResponseMs: number; value: number }>
  anomalies: Array<{ id: string; type: string; severity: string; status: string; title: string; entity: string | null; normalValue: number | null; observedValue: number | null; detectedAt: string }>
  recent: Array<{ transactionId: string; status: string; amount: number; paymentMethod: PaymentMethod; institution: { name: string }; merchant: { name: string }; createdAt: string; responseTimeMs: number }>
}

function LiveStrip() {
  const { snapshot, state } = useRealtime()
  if (!snapshot) return <p className="text-xs text-muted">{state === 'live' ? 'Waiting for the first live sample…' : 'Live metrics resume when the realtime connection is back.'}</p>
  const items = [
    ['Transactions / min', formatCount(snapshot.transactionsLastMinute)],
    ['Success (5 min)', fmtPct(snapshot.window5m.successRate)],
    ['Avg latency (5 min)', fmtMs(snapshot.window5m.avgLatencyMs)],
    ['API availability (5 min)', fmtPct(snapshot.window5m.apiAvailability, 2)],
    ['Pending now', formatCount(snapshot.pendingTransactions)],
  ]
  return (
    <div className="grid grid-cols-2 gap-3 rounded-3xl bg-panel p-4 text-white sm:grid-cols-3 lg:grid-cols-5" aria-label="Live metrics">
      {items.map(([label, value]) => (
        <div key={label}>
          <p className="text-[11px] uppercase tracking-wide text-white/60">{label}</p>
          <p className="mt-0.5 text-xl font-semibold tabular-nums">{value}</p>
        </div>
      ))}
      {snapshot.degradedServices.length ? (
        <p className="col-span-full text-xs text-amber-200">Degraded: {snapshot.degradedServices.map((service) => `${service.name} (${service.status.toLowerCase()})`).join(', ')}</p>
      ) : null}
    </div>
  )
}

export function DashboardPage() {
  const { user } = useAuth()
  const [range, setRange] = useState('24h')
  const query = useQuery({ queryKey: ['dashboard', 'overview', range], queryFn: () => api<Overview>(`/api/dashboard/overview?range=${range}`), refetchInterval: 30_000 })

  if (query.isLoading) return <div className="grid gap-3 md:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-28 rounded-3xl" />)}</div>
  if (query.isError) return <ErrorState message={errorMessage(query.error)} onRetry={() => query.refetch()} />
  const data = query.data!
  const k = data.kpis
  const kpis: Array<{ label: string; value: string; hint: string; tone?: string; href?: string }> = [
    { label: 'Transactions', value: formatCount(k.total), hint: data.range.label, href: '/transactions' },
    { label: 'Success rate', value: fmtPct(k.successRate, 2), hint: `${formatCount(k.successful)} successful`, tone: k.successRate < 90 ? 'bad' : undefined },
    { label: 'Failed', value: formatCount(k.failed), hint: `${fmtPct(k.failureRate, 2)} failure rate`, tone: k.failureRate > 8 ? 'bad' : undefined, href: '/transactions?status=FAILED' },
    { label: 'Pending', value: formatCount(k.pending), hint: 'Awaiting final status', href: '/transactions?status=PENDING' },
    { label: 'Value processed', value: formatNpr(k.value), hint: 'All statuses' },
    { label: 'API availability', value: fmtPct(k.apiAvailability, 2), hint: `${formatCount(k.apiCallsLastHour)} calls in the last hour`, tone: k.apiAvailability != null && k.apiAvailability < 95 ? 'bad' : undefined },
    { label: 'Latency avg / P95', value: `${fmtMs(k.avgResponseMs)} / ${fmtMs(k.p95Ms)}`, hint: 'Transaction response time' },
    { label: 'Active incidents', value: String(k.activeIncidents), hint: `${k.openAnomalies} open anomalies`, tone: k.activeIncidents ? 'warn' : undefined, href: '/incidents?active=true' },
  ]
  const toneClass = (tone?: string) => tone === 'bad' ? 'text-red-700 dark:text-red-300' : tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : ''

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[1.7rem] font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <StatusBadge status={data.systemStatus} />
            <span>{data.range.label}</span>
            <span>Updated {relTime(data.range.to)}</span>
          </p>
        </div>
        <Select label="Overview time range" value={range} onChange={setRange} options={RANGES} />
      </div>

      <LiveStrip />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Key metrics">
        {kpis.map((item) => {
          const body = (
            <>
              <p className="text-xs text-muted">{item.label}</p>
              <p className={`mt-1 text-2xl font-semibold tabular-nums tracking-tight ${toneClass(item.tone)}`}>{item.value}</p>
              <p className="mt-1 text-xs text-muted">{item.hint}</p>
            </>
          )
          return item.href
            ? <Link key={item.label} to={item.href} className="rounded-3xl border border-line bg-card p-4 transition hover:border-brand/40">{body}</Link>
            : <div key={item.label} className="rounded-3xl border border-line bg-card p-4">{body}</div>
        })}
      </section>

      <div className="grid gap-4 xl:grid-cols-12">
        <Card title="Transaction volume" className="xl:col-span-8" action={<Link to="/analytics" className="text-xs text-brand">Analytics</Link>}>
          {data.volume.some((row) => row.success + row.failed + row.pending > 0) ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.volume}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e9f0" />
                  <XAxis dataKey="time" tickFormatter={(value) => chartTick(value, data.range.unit)} tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={{ fontSize: 11 }} width={40} />
                  <Tooltip labelFormatter={(value) => chartTick(String(value), data.range.unit)} />
                  <Bar dataKey="success" name="Successful" stackId="a" fill="#2f6bff" />
                  <Bar dataKey="pending" name="Pending" stackId="a" fill="#f59e0b" />
                  <Bar dataKey="failed" name="Failed" stackId="a" fill="#dc2626" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <EmptyState title="No transactions in this range." />}
        </Card>

        <Card title="Operational alerts" className="xl:col-span-4">
          {data.aiAlerts.length ? (
            <ul className="space-y-2 text-sm">
              {data.aiAlerts.map((alert) => (
                <li key={alert.id} className={`rounded-2xl border px-3 py-2 ${alert.tone === 'bad' ? 'border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/40' : alert.tone === 'warn' ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/40' : 'border-line'}`}>
                  <Link to={alert.href} className="block">{alert.message}</Link>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="Nothing needs attention right now." />}
          <p className="mt-3 text-[11px] text-muted">Alerts are generated from live metrics and open records. Verify before acting.</p>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Card title="Active incidents" className="xl:col-span-6" action={can(user!.role, 'incidents:view') ? <Link to="/incidents?active=true" className="text-xs text-brand">All incidents</Link> : null}>
          {data.activeIncidents.length ? (
            <ul className="divide-y divide-line text-sm">
              {data.activeIncidents.map((incident) => (
                <li key={incident.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    {can(user!.role, 'incidents:view') ? <Link className="font-medium text-brand" to={`/incidents/${incident.id}`}>{incident.id}</Link> : <span className="font-medium">{incident.id}</span>}
                    <span className="ml-2">{incident.title}</span>
                    <p className="text-xs text-muted">{incident.services.join(', ') || 'Platform'} · {relTime(incident.createdAt)} · {incident.assignee ?? 'Unassigned'}</p>
                  </div>
                  <div className="flex gap-1"><StatusBadge status={incident.severity} /><StatusBadge status={incident.status} /></div>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No active incidents." />}
        </Card>

        <Card title="Service status" className="xl:col-span-6" action={can(user!.role, 'services:view') ? <Link to="/service-map" className="text-xs text-brand">Service map</Link> : null}>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {data.services.map((service) => (
              <li key={service.id} className="flex items-center justify-between gap-2 rounded-2xl border border-line px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{service.name}</p>
                  <p className="text-xs text-muted">{service.responseTimeMs != null ? fmtMs(service.responseTimeMs) : 'Not measured'}{service.errorRate != null ? ` · ${fmtPct(service.errorRate)} errors` : ''}</p>
                </div>
                <StatusBadge status={service.status} />
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Card title="Institutions" className="xl:col-span-7" action={can(user!.role, 'institutions:view') ? <Link to="/institutions" className="text-xs text-brand">All institutions</Link> : null}>
          <Table head={['Institution', 'Status', 'Transactions', 'Success', 'Avg latency', 'Value']} minWidth={560}>
            {data.institutions.map((row) => (
              <tr key={row.id}>
                <td>{can(user!.role, 'institutions:view') ? <Link className="font-medium text-brand" to={`/institutions/${row.id}`}>{row.name}</Link> : row.name}</td>
                <td><StatusBadge status={row.status} /></td>
                <td className="tabular-nums">{formatCount(row.transactions)}</td>
                <td className={`tabular-nums ${row.successRate < 90 ? 'text-red-700 dark:text-red-300' : ''}`}>{fmtPct(row.successRate)}</td>
                <td className="tabular-nums">{fmtMs(row.avgResponseMs)}</td>
                <td className="tabular-nums">{formatNpr(row.value)}</td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Payment methods" className="xl:col-span-5">
          <ul className="space-y-2 text-sm">
            {data.paymentMethods.map((row) => {
              const max = Math.max(...data.paymentMethods.map((item) => item.count), 1)
              return (
                <li key={row.method}>
                  <div className="flex justify-between"><span>{PAYMENT_LABEL[row.method] ?? row.method}</span><span className="tabular-nums text-muted">{formatCount(row.count)} · {formatNpr(row.value)}</span></div>
                  <div className="mt-1 h-2 rounded-full bg-[#eef2f7] dark:bg-white/10"><div className="h-2 rounded-full bg-brand" style={{ width: `${(row.count / max) * 100}%` }} /></div>
                </li>
              )
            })}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Card title="Recent anomalies" className="xl:col-span-5" action={can(user!.role, 'anomalies:view') ? <Link to="/anomalies" className="text-xs text-brand">All anomalies</Link> : null}>
          {data.anomalies.length ? (
            <ul className="divide-y divide-line text-sm">
              {data.anomalies.map((row) => (
                <li key={row.id} className="py-2">
                  <div className="flex items-center justify-between gap-2">
                    {can(user!.role, 'anomalies:view') ? <Link className="font-medium text-brand" to={`/anomalies?focus=${row.id}`}>{row.title}</Link> : <span className="font-medium">{row.title}</span>}
                    <StatusBadge status={row.severity} />
                  </div>
                  <p className="text-xs text-muted">{row.id} · {row.entity ?? 'Platform'} · {relTime(row.detectedAt)}</p>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="No anomalies detected." />}
        </Card>

        <Card title="Recent transactions" className="xl:col-span-7" action={can(user!.role, 'transactions:view') ? <Link to="/transactions" className="text-xs text-brand">All transactions</Link> : null}>
          {data.recent.length ? (
            <Table head={['Transaction', 'Merchant', 'Bank', 'Amount', 'Status', 'When']} minWidth={600}>
              {data.recent.map((row) => (
                <tr key={row.transactionId}>
                  <td>{can(user!.role, 'transactions:view') ? <Link className="font-medium text-brand" to={`/transactions/${row.transactionId}`}>{row.transactionId}</Link> : row.transactionId}</td>
                  <td>{row.merchant.name}</td>
                  <td>{row.institution.name}</td>
                  <td className="tabular-nums">{formatNpr(row.amount)}</td>
                  <td><StatusBadge status={row.status} /></td>
                  <td className="text-muted">{relTime(row.createdAt)}</td>
                </tr>
              ))}
            </Table>
          ) : <EmptyState title="No transactions yet." />}
        </Card>
      </div>
    </div>
  )
}
