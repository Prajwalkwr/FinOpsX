import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { can, formatNpr, PAYMENT_LABEL, type PaymentMethod } from '@finopsx/shared'
import { api, errorMessage } from '../api'
import { useAuth } from '../contexts'
import { axisTick, gridStroke, PALETTE, tooltipStyle } from '../lib/chart'
import { chartTick, fmtDateTime, fmtMs, fmtPct, humanize, useUrlFilters } from '../lib/format'
import { Card, EmptyState, ErrorState, PageHeader, Select, Skeleton, Stat, Table } from '../components/ui'

const RANGES: Array<[string, string]> = [['24h', 'Last 24 hours'], ['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']]

type Analytics = {
  range: { label: string; unit: string }
  metrics: { total: number; successful: number; failed: number; pending: number; reversed: number; value: number; successValue: number; successRate: number; failureRate: number; pendingRate: number; avgLatencyMs: number | null; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null }
  volume: Array<{ time: string; success: number; failed: number; pending: number; other: number; value: number }>
  institutions: Array<{ id: string; code: string; name: string; transactions: number; successRate: number; failureRate: number; avgResponseMs: number; value: number }>
  merchants: Array<{ id: string; name: string; category: string; transactions: number; value: number; failureRate: number; average: number; anomalies: number }>
  paymentMethods: Array<{ method: string; transactions: number; value: number; successRate: number; failureRate: number; avgResponseMs: number }>
  failureReasons: Array<{ reason: string; count: number }>
  hourly: Array<{ hour: number; transactions: number; failureRate: number }>
}

export function AnalyticsPage() {
  const { user } = useAuth()
  const [filters, setFilters] = useUrlFilters({ range: '7d' })
  const [selected, setSelected] = useState<string[]>([])
  const query = useQuery({ queryKey: ['analytics', filters.range], queryFn: () => api<Analytics>(`/api/analytics?range=${filters.range}`), refetchInterval: 60_000 })
  if (query.isLoading) return <Skeleton className="h-80" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} />
  const data = query.data!
  const canTx = Boolean(user && can(user.role, 'transactions:view'))
  const compared = selected.length ? data.institutions.filter((item) => selected.includes(item.id)) : data.institutions
  const unit = data.range.unit === 'day' ? 'day' : undefined
  return (
    <div className="space-y-4">
      <PageHeader
        title="Analytics"
        description={`Synthetic transaction analytics for ${data.range.label.toLowerCase()}. The same aggregates feed the Overview, reports and the AI assistant.`}
        actions={<Select label="Range" value={filters.range} onChange={(range) => setFilters({ range })} options={RANGES} />}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Transactions" value={data.metrics.total.toLocaleString('en-US')} hint={formatNpr(data.metrics.value)} />
        <Stat label="Success rate" value={fmtPct(data.metrics.successRate)} tone="good" hint={`${data.metrics.successful.toLocaleString('en-US')} successful`} />
        <Stat label="Failure rate" value={fmtPct(data.metrics.failureRate)} tone={data.metrics.failureRate >= 10 ? 'bad' : undefined} hint={`${data.metrics.failed.toLocaleString('en-US')} failed`} />
        <Stat label="Pending" value={data.metrics.pending.toLocaleString('en-US')} hint={`${data.metrics.reversed} reversed`} />
        <Stat label="Latency P50 / P95 / P99" value={<span className="text-base">{fmtMs(data.metrics.p50Ms)} / {fmtMs(data.metrics.p95Ms)} / {fmtMs(data.metrics.p99Ms)}</span>} />
      </div>

      <Card title="Transaction trend by outcome">
        {data.volume.length ? (
          <div className="h-64" role="img" aria-label="Transactions by outcome over time">
            <ResponsiveContainer>
              <AreaChart data={data.volume}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                <XAxis dataKey="time" tickFormatter={(value) => chartTick(value, unit)} tick={axisTick} minTickGap={40} />
                <YAxis tick={axisTick} width={44} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={(value) => fmtDateTime(String(value))} />
                <Area type="monotone" stackId="1" dataKey="success" name="Successful" stroke="#10b981" fill="#10b981" fillOpacity={0.35} />
                <Area type="monotone" stackId="1" dataKey="pending" name="Pending" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.35} />
                <Area type="monotone" stackId="1" dataKey="failed" name="Failed" stroke="#ef4444" fill="#ef4444" fillOpacity={0.35} />
                <Area type="monotone" stackId="1" dataKey="other" name="Reversed / other" stroke="#64748b" fill="#64748b" fillOpacity={0.3} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : <EmptyState title="No transactions in this range." />}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Payment methods">
          {data.paymentMethods.length ? (
            <div className="grid gap-3 md:grid-cols-[180px_1fr]">
              <div className="h-44">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={data.paymentMethods} dataKey="transactions" nameKey="method" innerRadius={45} outerRadius={75}>
                      {data.paymentMethods.map((row, index) => <Cell key={row.method} fill={PALETTE[index % PALETTE.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [Number(value).toLocaleString('en-US'), PAYMENT_LABEL[name as PaymentMethod] ?? name]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <Table head={['Method', 'Tx', 'Success', 'Avg']} minWidth={320}>
                {data.paymentMethods.map((row, index) => (
                  <tr key={row.method}>
                    <td><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: PALETTE[index % PALETTE.length] }} />{PAYMENT_LABEL[row.method as PaymentMethod] ?? humanize(row.method)}</td>
                    <td className="tabular-nums">{row.transactions.toLocaleString('en-US')}</td>
                    <td className="tabular-nums">{fmtPct(row.successRate)}</td>
                    <td className="tabular-nums">{fmtMs(row.avgResponseMs)}</td>
                  </tr>
                ))}
              </Table>
            </div>
          ) : <EmptyState title="No payments in this range." />}
        </Card>
        <Card title="Failure reasons">
          {data.failureReasons.length ? (
            <div className="h-56">
              <ResponsiveContainer>
                <BarChart data={data.failureReasons.map((row) => ({ ...row, label: humanize(row.reason) }))} layout="vertical" margin={{ left: 20 }}>
                  <XAxis type="number" tick={axisTick} />
                  <YAxis type="category" dataKey="label" tick={axisTick} width={150} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name="Failures" fill="#ef4444" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <p className="text-sm text-muted">No failures in this range.</p>}
        </Card>
      </div>

      <Card title="Hourly pattern (Nepal time)">
        <div className="h-52" role="img" aria-label="Transactions by hour of day">
          <ResponsiveContainer>
            <BarChart data={data.hourly}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
              <XAxis dataKey="hour" tick={axisTick} tickFormatter={(hour) => `${String(hour).padStart(2, '0')}:00`} interval={2} />
              <YAxis tick={axisTick} width={44} />
              <Tooltip contentStyle={tooltipStyle} labelFormatter={(hour) => `${String(hour).padStart(2, '0')}:00–${String(hour).padStart(2, '0')}:59`} formatter={(value, name) => name === 'Failure rate' ? `${Number(value).toFixed(1)}%` : Number(value).toLocaleString('en-US')} />
              <Bar dataKey="transactions" name="Transactions" fill="#2f6bff" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card title="Institution comparison">
        <div className="mb-3 flex flex-wrap gap-3">
          {data.institutions.map((item) => (
            <label key={item.id} className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
              {item.name}
            </label>
          ))}
        </div>
        <div className="h-56">
          <ResponsiveContainer>
            <BarChart data={compared}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
              <XAxis dataKey="code" tick={axisTick} />
              <YAxis tick={axisTick} width={36} unit="%" />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => `${Number(value).toFixed(2)}%`} />
              <Bar dataKey="failureRate" name="Failure rate" fill="#f59e0b" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3">
          <Table head={['Institution', 'Transactions', 'Success', 'Failure', 'Avg response', 'Value']} minWidth={640}>
            {compared.map((item) => (
              <tr key={item.id}>
                <td><Link className="text-brand" to={`/institutions/${item.code}?range=${filters.range}`}>{item.name}</Link></td>
                <td className="tabular-nums">{item.transactions.toLocaleString('en-US')}</td>
                <td className="tabular-nums">{item.transactions ? fmtPct(item.successRate) : '—'}</td>
                <td className="tabular-nums">{item.transactions ? fmtPct(item.failureRate) : '—'}</td>
                <td className="tabular-nums">{item.transactions ? fmtMs(item.avgResponseMs) : '—'}</td>
                <td className="tabular-nums">{formatNpr(item.value)}</td>
              </tr>
            ))}
          </Table>
        </div>
      </Card>

      <Card title="Top merchants" action={<Link className="text-xs text-brand" to={`/analytics/merchants?range=${filters.range}`}>All merchants →</Link>}>
        <MerchantTable rows={data.merchants.slice(0, 10)} canTx={canTx} range={filters.range} />
      </Card>
    </div>
  )
}

function MerchantTable({ rows, canTx, range }: { rows: Analytics['merchants']; canTx: boolean; range: string }) {
  if (!rows.length) return <EmptyState title="No merchant activity in this range." />
  return (
    <Table head={['Merchant', 'Category', 'Transactions', 'Value', 'Average', 'Failure', 'Anomalies']} minWidth={720}>
      {rows.map((row) => (
        <tr key={row.id}>
          <td>{canTx ? <Link className="text-brand" to={`/transactions?q=${encodeURIComponent(row.name)}&range=${range}`}>{row.name}</Link> : row.name}</td>
          <td className="text-muted">{humanize(row.category)}</td>
          <td className="tabular-nums">{row.transactions.toLocaleString('en-US')}</td>
          <td className="tabular-nums">{formatNpr(row.value)}</td>
          <td className="tabular-nums">{formatNpr(row.average)}</td>
          <td className="tabular-nums">{fmtPct(row.failureRate)}</td>
          <td className="tabular-nums">{row.anomalies ? <Link className="text-brand" to={`/anomalies?q=${encodeURIComponent(row.name)}`}>{row.anomalies}</Link> : 0}</td>
        </tr>
      ))}
    </Table>
  )
}

export function MerchantsPage() {
  const { user } = useAuth()
  const [filters, setFilters] = useUrlFilters({ range: '7d' })
  const query = useQuery({ queryKey: ['merchants', filters.range], queryFn: () => api<Analytics['merchants']>(`/api/analytics/merchants?range=${filters.range}`) })
  return (
    <div>
      <Link to="/analytics" className="text-sm text-brand">← Analytics</Link>
      <PageHeader title="Merchant analytics" description="Synthetic demo merchants ranked by transaction value." actions={<Select label="Range" value={filters.range} onChange={(range) => setFilters({ range })} options={RANGES} />} />
      {query.isLoading ? <Skeleton className="h-64" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : <MerchantTable rows={query.data ?? []} canTx={Boolean(user && can(user.role, 'transactions:view'))} range={filters.range} />}
    </div>
  )
}
