import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { can, formatCount, formatDuration, formatNpr, formatPercent, ROLE_LABEL } from '@finopsx/shared'
import { api } from '../api'
import { useAuth, useToast } from '../contexts'
import { EmptyState, ErrorState, Skeleton } from '../components/ui'

const RANGES = ['1h', '6h', '24h', '7d', '30d', 'today', 'yesterday']
const SCENARIOS = ['BANK_API_LATENCY', 'PAYMENT_FAILURE_SPIKE', 'SETTLEMENT_DELAY', 'NOTIFICATION_DEGRADATION', 'HIGH_VOLUME', 'MERCHANT_ACTIVITY']
const METHOD_LABEL: Record<string, string> = {
  CARD: 'Card payments',
  BANK_TRANSFER: 'Bank transfers',
  WALLET: 'Wallet payments',
  QR: 'QR payments',
  MOBILE_BANKING: 'Mobile banking',
}

type Summary = {
  systemStatus: string
  healthScore: number
  kpis: { total: number; successful: number; failed: number; pending: number; successRate: number; value: number; activeIncidents: number; apiAvailability: number; avgResponseMs: number }
  services: Array<{ key: string; name: string; status: string; responseTimeMs: number; uptime: number; lastCheckedAt: string }>
  alerts: Array<{ id: string; title: string; type: string; severity: string; link: string }>
  topInstitutions: Array<{ id: string; name: string; successRate: number; failureRate: number }>
  recent: Array<{ transactionId: string; status: string; amount: number; paymentMethod?: string; institution: { name: string } | null; merchant: { name: string } | null; createdAt: string }>
}

function relTime(iso?: string) {
  if (!iso) return 'just now'
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  return `${Math.round(mins / 60)} hr ago`
}

function sample<T>(rows: T[], count: number) {
  if (rows.length <= count) return rows
  const step = (rows.length - 1) / (count - 1)
  return Array.from({ length: count }, (_, index) => rows[Math.round(index * step)])
}

function MiniBars({ values }: { values: number[] }) {
  const peak = Math.max(...values, 1)
  return (
    <div className="flex h-7 items-end gap-[3px]" aria-hidden="true">
      {values.map((value, index) => (
        <span key={index} className="w-[5px] rounded-[2px] bg-brand" style={{ height: `${Math.max(18, (value / peak) * 100)}%`, opacity: 0.45 + (index / values.length) * 0.55 }} />
      ))}
    </div>
  )
}

function SegmentBar({ value, max }: { value: number; max: number }) {
  const filled = Math.round((value / Math.max(max, 1)) * 16)
  return (
    <div className="mt-2 flex gap-1" aria-hidden="true">
      {Array.from({ length: 16 }, (_, index) => (
        <span key={index} className={`h-6 w-1.5 rounded-sm ${index < filled ? 'bg-brand' : 'bg-[#e7edf5] dark:bg-white/10'}`} />
      ))}
    </div>
  )
}

function statusPill(status: string) {
  if (status === 'SUCCESS') return { label: 'Completed', className: 'bg-emerald-50 text-emerald-600' }
  if (status === 'PENDING') return { label: 'Pending', className: 'bg-orange-50 text-orange-500' }
  if (status === 'FAILED') return { label: 'Failed', className: 'bg-red-50 text-red-600' }
  return { label: status.replaceAll('_', ' '), className: 'bg-slate-100 text-slate-600' }
}

export function DashboardPage() {
  const { user } = useAuth()
  const toast = useToast()
  const [range, setRange] = useState('24h')
  const [series, setSeries] = useState<'all' | 'success' | 'failed'>('all')
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'FAILED' | 'SUCCESS'>('ALL')
  const summary = useQuery({ queryKey: ['dashboard', 'summary', range], queryFn: () => api<Summary>(`/api/dashboard/summary?range=${range}`) })
  const volume = useQuery({ queryKey: ['dashboard', 'volume', range], queryFn: () => api<Array<{ time: string; success: number; failed: number; pending: number }>>(`/api/dashboard/volume?range=${range}`) })
  const payments = useQuery({
    queryKey: ['payments', range],
    enabled: Boolean(user && can(user.role, 'analytics:view')),
    queryFn: () => api<Array<{ paymentMethod: string; status: string; _count: { _all: number } }>>(`/api/analytics/payments?range=${range}`),
  })
  const simulator = useQuery({
    queryKey: ['simulator'],
    enabled: Boolean(user && can(user.role, 'simulator:control')),
    queryFn: () => api<{ running: boolean; scenario: string | null; tpm: number; warning: string }>('/api/simulator/status'),
  })

  const bars = useMemo(() => sample(volume.data ?? [], 14).map((row) => ({
    ...row,
    label: row.time.slice(11, 16) || row.time.slice(5, 10),
    shown: series === 'failed' ? row.failed : series === 'success' ? row.success : row.success + row.failed + row.pending,
  })), [volume.data, series])
  const spark = useMemo(() => (volume.data ?? []).map((row) => row.success + row.failed + row.pending), [volume.data])
  const channels = useMemo(() => {
    const totals = new Map<string, number>()
    for (const row of payments.data ?? []) totals.set(row.paymentMethod, (totals.get(row.paymentMethod) ?? 0) + row._count._all)
    return [...totals.entries()].sort((a, b) => b[1] - a[1])
  }, [payments.data])

  if (summary.isLoading) return <div className="grid gap-3 md:grid-cols-4">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-28 rounded-3xl" />)}</div>
  if (summary.isError) return <ErrorState message={(summary.error as { message: string }).message} onRetry={() => summary.refetch()} />
  const data = summary.data!
  const synced = data.services.map((service) => service.lastCheckedAt).sort().at(-1)
  const recent = data.recent.filter((row) => filter === 'ALL' || row.status === filter)
  const channelMax = channels[0]?.[1] ?? 1
  const when = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kathmandu' })

  async function scenario(name: string) {
    try {
      await api('/api/simulator/scenario', { method: 'POST', headers: { 'Idempotency-Key': `${name}-${Date.now()}` }, body: JSON.stringify({ name }) })
      toast.push('Scenario started. Watch health, anomalies, and incidents.')
      simulator.refetch()
      summary.refetch()
    } catch (error) {
      toast.push((error as { message: string }).message, 'err')
    }
  }

  const metrics = [
    { label: 'Total volume', value: formatNpr(data.kpis.value), hint: 'Processed transactions', values: spark },
    { label: 'Successful', value: formatCount(data.kpis.successful), hint: `${formatPercent(data.kpis.successRate)} success`, values: (volume.data ?? []).map((row) => row.success) },
    { label: 'Failed', value: formatCount(data.kpis.failed), hint: `${data.kpis.activeIncidents} active incidents`, values: (volume.data ?? []).map((row) => row.failed) },
    { label: 'Pending settlements', value: formatCount(data.kpis.pending), hint: `${formatDuration(data.kpis.avgResponseMs)} avg response`, values: (volume.data ?? []).map((row) => row.pending) },
  ]

  return (
    <div className="md:pr-56">
      <div>
        <h1 className="text-[1.7rem] font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-brand" /> Account · {user ? ROLE_LABEL[user.role] : 'Operations'}</span>
          <span>Last synced {relTime(synced)}</span>
          <span>{data.systemStatus}</span>
          <label>Range
            <select className="ml-2 rounded-full border border-line bg-card px-3 py-1 text-sm text-ink" value={range} onChange={(event) => setRange(event.target.value)} aria-label="Dashboard range">
              {RANGES.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
        </p>
      </div>

      <section className="mt-6 grid gap-6 md:grid-cols-4 md:divide-x md:divide-[#eef2f6] dark:md:divide-white/10">
        {metrics.map((metric) => (
          <div key={metric.label} className="min-w-0 xl:px-4 xl:first:pl-0">
            <p className="text-sm text-muted">{metric.label}</p>
            <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">{metric.value}</p>
            <div className="mt-4 flex items-end justify-between gap-3">
              <p className="text-xs text-muted">{metric.hint}</p>
              <MiniBars values={sample(metric.values.length ? metric.values : [1, 2, 1, 3, 2, 4, 2, 3], 12)} />
            </div>
          </div>
        ))}
      </section>

      <div className="mt-6 grid gap-4 xl:grid-cols-12">
        <section className="rounded-[28px] bg-panel p-5 text-white xl:col-span-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-white/70">Transaction volume</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight">{formatNpr(data.kpis.value)}</p>
            </div>
            <span className="rounded-full bg-white/10 px-2 py-1 text-xs text-emerald-300">{formatPercent(data.kpis.successRate)} success</span>
          </div>
          <div className="mt-4 flex gap-4 text-xs text-white/70">
            {([['all', 'All'], ['success', 'Successful'], ['failed', 'Failed']] as const).map(([key, label]) => (
              <button key={key} className={series === key ? 'text-white' : ''} onClick={() => setSeries(key)}>{label}</button>
            ))}
          </div>
          <div className="mt-2 h-44">
            {bars.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bars} barCategoryGap={6}>
                  <XAxis dataKey="label" tick={{ fill: '#9fb0d0', fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <Tooltip contentStyle={{ background: '#0c1428', border: 'none', borderRadius: 12, color: '#fff' }} />
                  <Bar dataKey="shown" fill="#6ea2ff" radius={[5, 5, 2, 2]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <p className="pt-10 text-sm text-white/70">No transactions in this range.</p>}
          </div>
        </section>

        <section className="rounded-[28px] border border-line p-5 xl:col-span-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Payment channels</h2>
            <Link to="/analytics" className="text-xs text-muted" aria-label="Open analytics">↗</Link>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
            {(channels.length ? channels.slice(0, 3) : [['CARD', 0], ['BANK_TRANSFER', 0], ['WALLET', 0]] as Array<[string, number]>).map(([method, count]) => (
              <div key={method} className="min-w-0">
                <p className="truncate text-xs text-muted">{METHOD_LABEL[method] ?? method}</p>
                <p className="mt-1 font-semibold">{formatCount(count)} <span className="text-xs font-normal text-muted">txns</span></p>
              </div>
            ))}
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {(channels.slice(0, 2).length ? channels.slice(0, 2) : [['QR', 0], ['CARD', 0]] as Array<[string, number]>).map(([method, count]) => (
              <div key={method}>
                <p className="text-xs text-muted">{METHOD_LABEL[method] ?? method}</p>
                <p className="text-2xl font-semibold tabular-nums">{formatCount(count)}</p>
                <SegmentBar value={count} max={channelMax} />
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[28px] border border-line p-5 xl:col-span-3">
          <h2 className="font-semibold">Risk monitoring</h2>
          <p className="mt-3 text-xs text-muted">Overview</p>
          <p className="text-sm font-medium">System alerts</p>
          {data.alerts.length ? (
            <table className="mt-3 w-full text-left text-xs">
              <thead className="text-muted"><tr><th className="py-1 font-medium">Risk type</th><th className="font-medium">Status</th><th className="font-medium">Action</th></tr></thead>
              <tbody>
                {data.alerts.slice(0, 4).map((alert) => (
                  <tr key={alert.id} className="border-t border-line">
                    <td className="py-2 pr-2">{alert.title}</td>
                    <td className="text-muted">{alert.severity.replaceAll('_', ' ')}</td>
                    <td><Link className="text-brand" to={alert.link}>Review</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState title="No alerts in this range." />}
        </section>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-12">
        <section className="rounded-[28px] border border-line p-5 xl:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Recent transactions</h2>
            <div className="flex gap-1 rounded-full bg-[#f4f6fa] p-1 text-xs dark:bg-white/5">
              {([['ALL', 'All'], ['PENDING', 'Pending'], ['FAILED', 'Failed'], ['SUCCESS', 'Completed']] as const).map(([key, label]) => (
                <button key={key} className={`rounded-full px-3 py-1 ${filter === key ? 'bg-white font-medium shadow-sm dark:bg-white/10' : 'text-muted'}`} onClick={() => setFilter(key)}>{label}</button>
              ))}
            </div>
          </div>
          {recent.length ? (
            <div className="table-wrap mt-3">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted"><tr><th className="py-2 font-medium">#</th><th className="font-medium">Merchant</th><th className="font-medium">Amount</th><th className="font-medium">Payment method</th><th className="font-medium">Status</th><th className="font-medium">Date</th></tr></thead>
                <tbody>
                  {recent.slice(0, 6).map((row, index) => {
                    const pill = statusPill(row.status)
                    return (
                      <tr key={row.transactionId} className="border-t border-line">
                        <td className="py-3 text-muted">{String(index + 1).padStart(2, '0')}</td>
                        <td><Link className="font-medium" to={`/transactions/${row.transactionId}`}>{row.merchant?.name ?? row.institution?.name ?? row.transactionId}</Link></td>
                        <td className="tabular-nums">{formatNpr(row.amount)}</td>
                        <td className="text-muted">{METHOD_LABEL[row.paymentMethod ?? ''] ?? row.paymentMethod ?? '—'}</td>
                        <td><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${pill.className}`}>{pill.label}</span></td>
                        <td className="text-muted">{when.format(new Date(row.createdAt))}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : <EmptyState title="No transactions for this filter." detail="Choose another status or widen the date range." />}
        </section>

        <section className="rounded-[28px] bg-panel p-5 text-white xl:col-span-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-white/70">Daily transactions</p>
              <p className="mt-1 text-4xl font-semibold tracking-tight">{formatCount(data.kpis.total)}</p>
            </div>
            <p className="text-right text-xs text-white/60">{formatCount(Math.max(...spark, data.kpis.total))}<br />peak</p>
          </div>
          <div className="mt-6 flex h-16 items-end gap-[3px]">
            {sample(spark.length ? spark : [2, 4, 3, 6, 5, 8, 4, 7, 6, 9, 5, 8, 7, 4, 6, 8, 5, 7], 28).map((value, index, list) => (
              <span key={index} className="flex-1 rounded-sm bg-[#7eb0ff]" style={{ height: `${Math.max(18, (value / Math.max(...list, 1)) * 100)}%`, opacity: 0.45 + (index / list.length) * 0.55 }} />
            ))}
          </div>
          <div className="mt-6 grid grid-cols-3 gap-3 border-t border-white/10 pt-4 text-sm">
            <div><p className="text-lg font-semibold">{formatNpr(data.kpis.value)}</p><p className="text-xs text-white/60">Payment volume</p></div>
            <div><p className="text-lg font-semibold">{formatCount(data.kpis.failed)}</p><p className="text-xs text-white/60">Failed</p></div>
            <div><p className="text-lg font-semibold">{formatPercent(data.kpis.apiAvailability, 1)}</p><p className="text-xs text-white/60">API availability</p></div>
          </div>
        </section>
      </div>

      {user && can(user.role, 'simulator:control') ? (
        <section className="mt-4 rounded-[28px] border border-line p-5">
          <h2 className="font-semibold">Demo controls</h2>
          <p className="mt-1 text-sm text-muted">{simulator.data?.warning} Simulator {simulator.data?.running ? 'running' : 'stopped'} at {simulator.data?.tpm ?? 0}/min. Active scenario: {simulator.data?.scenario ?? 'none'}.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="rounded-full bg-brand px-3 py-2 text-xs text-white" onClick={async () => { await api('/api/simulator/start', { method: 'POST' }); toast.push('Simulator started'); simulator.refetch() }}>Start</button>
            <button className="rounded-full border border-line px-3 py-2 text-xs" onClick={async () => { await api('/api/simulator/stop', { method: 'POST' }); toast.push('Simulator stopped'); simulator.refetch() }}>Stop</button>
            <button className="rounded-full border border-line px-3 py-2 text-xs" onClick={async () => { if (confirm('Reset simulator configuration and end the active scenario?')) { await api('/api/simulator/reset', { method: 'POST' }); toast.push('Simulator reset'); simulator.refetch() } }}>Reset</button>
            {SCENARIOS.map((name) => (
              <button key={name} className="rounded-full border border-amber-200 px-3 py-2 text-xs" onClick={() => scenario(name)}>{name.replaceAll('_', ' ')}</button>
            ))}
            <button className="rounded-full border border-emerald-200 px-3 py-2 text-xs" onClick={async () => { await api('/api/simulator/scenario/resolve', { method: 'POST' }); toast.push('Scenario resolved'); summary.refetch() }}>Resolve scenario</button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
