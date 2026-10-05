import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDuration, formatNpr, formatPercent } from '@finopsx/shared'
import { api } from '../api'
import { Card, ErrorState, Skeleton } from '../components/ui'

export function AnalyticsPage() {
  const [range, setRange] = useState('7d')
  const [selected, setSelected] = useState<string[]>([])
  const query = useQuery({ queryKey: ['analytics', range], queryFn: () => api<{
    metrics: { total: number; successRate: number; failureRate: number; avgLatencyMs: number; p95Ms: number; p99Ms: number; value: number }
    institutions: Array<{ id: string; name: string; transactions: number; successRate: number; failureRate: number; avgResponseMs: number; value: number }>
    volume: Array<{ time: string; success: number; failed: number }>
  }>(`/api/analytics/overview?range=${range}`) })
  const payments = useQuery({ queryKey: ['payments', range], queryFn: () => api<Array<{ paymentMethod: string; status: string; _count: { _all: number } }>>(`/api/analytics/payments?range=${range}`) })
  if (query.isLoading) return <Skeleton className="h-64" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  const data = query.data!
  const compared = data.institutions.filter((item) => selected.includes(item.id))
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-xl font-semibold">Analytics</h1><select aria-label="Analytics range" className="rounded border border-line bg-card px-2 py-1 text-sm" value={range} onChange={(event) => setRange(event.target.value)}>{['today', '7d', '30d'].map((item) => <option key={item}>{item}</option>)}</select></div>
      <div className="grid gap-3 sm:grid-cols-4 text-sm">
        <Card><p className="text-xs text-muted">Transactions</p><p className="text-xl font-semibold">{data.metrics.total.toLocaleString('en-US')}</p></Card>
        <Card><p className="text-xs text-muted">Failure rate</p><p className="text-xl font-semibold">{formatPercent(data.metrics.failureRate)}</p></Card>
        <Card><p className="text-xs text-muted">P95 / P99</p><p className="text-xl font-semibold">{formatDuration(data.metrics.p95Ms)} / {formatDuration(data.metrics.p99Ms)}</p></Card>
        <Card><p className="text-xs text-muted">Value</p><p className="text-xl font-semibold">{formatNpr(data.metrics.value)}</p></Card>
      </div>
      <Card title="Transaction trends"><div className="h-56"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.volume}><XAxis dataKey="time" hide /><YAxis /><Tooltip /><Bar dataKey="success" stackId="a" fill="#15803d" /><Bar dataKey="failed" stackId="a" fill="#b91c1c" /></BarChart></ResponsiveContainer></div></Card>
      <Card title="Institution comparison" action={<Link className="text-xs text-blue-700" to="/analytics/merchants">Merchants</Link>}>
        <div className="mb-3 flex flex-wrap gap-2">{data.institutions.map((item) => <label key={item.id} className="text-xs"><input type="checkbox" className="mr-1" checked={selected.includes(item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />{item.name}</label>)}</div>
        <div className="h-56"><ResponsiveContainer width="100%" height="100%"><BarChart data={(compared.length ? compared : data.institutions)}><XAxis dataKey="name" hide /><YAxis /><Tooltip /><Bar dataKey="failureRate" fill="#b45309" /></BarChart></ResponsiveContainer></div>
        <div className="table-wrap mt-3"><table className="w-full text-left text-sm"><thead className="text-xs text-muted"><tr><th>Institution</th><th>Tx</th><th>Success</th><th>Failure</th><th>Latency</th><th>Value</th></tr></thead><tbody>{(compared.length ? compared : data.institutions).map((item) => <tr key={item.id} className="border-t border-line"><td className="py-1"><Link className="text-blue-700" to={`/institutions/${item.id}`}>{item.name}</Link></td><td>{item.transactions}</td><td>{formatPercent(item.successRate)}</td><td>{formatPercent(item.failureRate)}</td><td>{formatDuration(item.avgResponseMs)}</td><td>{formatNpr(item.value)}</td></tr>)}</tbody></table></div>
      </Card>
      <Card title="Payment methods">
        <ul className="text-sm">{payments.data?.map((row) => <li key={row.paymentMethod + row.status}>{row.paymentMethod} · {row.status} · {row._count._all}</li>)}</ul>
      </Card>
    </div>
  )
}

export function MerchantsPage() {
  const query = useQuery({ queryKey: ['merchants'], queryFn: () => api<Array<{ name: string; category: string; transactions: number; value: number; failureRate: number; average: number; anomalies: number }>>('/api/analytics/merchants?range=30d') })
  if (query.isLoading) return <Skeleton className="h-64" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  return (
    <div>
      <Link to="/analytics" className="text-sm text-blue-700">Analytics</Link>
      <h1 className="my-3 text-xl font-semibold">Merchant analytics</h1>
      <div className="table-wrap rounded-lg border border-line bg-card"><table className="w-full min-w-[720px] text-left text-sm"><thead className="text-xs text-muted"><tr><th className="p-2">Merchant</th><th>Category</th><th>Volume</th><th>Value</th><th>Failure</th><th>Average</th><th>Anomalies</th></tr></thead><tbody>{query.data?.map((row) => <tr key={row.name} className="border-t border-line"><td className="p-2">{row.name}</td><td>{row.category}</td><td>{row.transactions}</td><td>{formatNpr(row.value)}</td><td>{formatPercent(row.failureRate)}</td><td>{formatNpr(row.average)}</td><td>{row.anomalies}</td></tr>)}</tbody></table></div>
    </div>
  )
}
