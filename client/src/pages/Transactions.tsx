import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { formatDuration, formatNpr, PAYMENT_LABEL, type PaymentMethod } from '@finopsx/shared'
import { api } from '../api'
import { useAuth } from '../contexts'
import { Button, Drawer, EmptyState, ErrorState, Pagination, Skeleton, StatusBadge } from '../components/ui'

type Row = {
  transactionId: string
  createdAt: string
  amount: number
  paymentMethod: PaymentMethod
  status: string
  responseTimeMs: number
  riskScore: number
  institution: { name: string } | null
  merchant: { name: string } | null
}
type Page = { items: Row[]; page: number; totalPages: number; total: number }

const PRESETS = ['ALL', 'SUCCESSFUL', 'FAILED', 'PENDING', 'HIGH_VALUE', 'SUSPICIOUS', 'REFUNDED', 'CANCELLED']

export function TransactionsPage() {
  const [page, setPage] = useState(1)
  const [q, setQ] = useState('')
  const [preset, setPreset] = useState('ALL')
  const [sort, setSort] = useState('createdAt')
  const [filters, setFilters] = useState(false)
  const query = useQuery({
    queryKey: ['transactions', page, q, preset, sort],
    queryFn: () => api<Page>(`/api/transactions?page=${page}&limit=25&q=${encodeURIComponent(q)}&preset=${preset}&sort=${sort}&dir=desc`),
  })
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Transactions</h1>
        <div className="flex gap-2">
          <input aria-label="Search transactions" className="rounded-md border border-line bg-card px-3 py-2 text-sm" placeholder="Transaction, customer, merchant" value={q} onChange={(event) => { setPage(1); setQ(event.target.value) }} />
          <Button variant="ghost" className="md:hidden" onClick={() => setFilters(true)}>Filters</Button>
        </div>
      </div>
      <div className="mb-3 hidden flex-wrap gap-2 md:flex">
        {PRESETS.map((item) => <button key={item} className={`rounded-full px-3 py-1 text-xs ${preset === item ? 'bg-brand text-white' : 'border border-line'}`} onClick={() => { setPreset(item); setPage(1) }}>{item.replaceAll('_', ' ')}</button>)}
        <label className="text-xs">Sort
          <select className="ml-2 rounded border border-line bg-card px-2 py-1" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort transactions">
            {['createdAt', 'amount', 'responseTimeMs', 'riskScore', 'status'].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      </div>
      {filters ? <Drawer title="Filters" onClose={() => setFilters(false)}><div className="grid gap-2">{PRESETS.map((item) => <button key={item} className="rounded border border-line px-3 py-2 text-left text-sm" onClick={() => { setPreset(item); setFilters(false) }}>{item}</button>)}</div></Drawer> : null}
      {query.isLoading ? <Skeleton className="h-64" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={(query.error as { message: string }).message} /> : query.data?.items.length ? (
        <>
          <div className="table-wrap rounded-lg border border-line bg-card">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="text-xs text-muted"><tr><th className="p-2">Transaction</th><th>Timestamp</th><th>Bank</th><th>Merchant</th><th>Amount</th><th>Method</th><th>Status</th><th>Response</th><th>Risk</th><th></th></tr></thead>
              <tbody>
                {query.data.items.map((row) => (
                  <tr key={row.transactionId} className="border-t border-line">
                    <td className="p-2 font-medium">{row.transactionId}</td>
                    <td>{new Date(row.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', hour12: false })}</td>
                    <td>{row.institution?.name}</td>
                    <td>{row.merchant?.name}</td>
                    <td>{formatNpr(row.amount)}</td>
                    <td>{PAYMENT_LABEL[row.paymentMethod]}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td>{formatDuration(row.responseTimeMs)}</td>
                    <td>{row.riskScore}</td>
                    <td><Link className="text-blue-700" to={`/transactions/${row.transactionId}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={setPage} />
          <p className="mt-2 text-xs text-muted">{query.data.total.toLocaleString('en-US')} matching synthetic transactions. Customer IDs are masked.</p>
        </>
      ) : <EmptyState title="No transactions found." detail="Try changing the selected filter." />}
    </div>
  )
}

export function TransactionDetailPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const query = useQuery({
    queryKey: ['transaction', id],
    queryFn: async () => {
      const row = await api<Record<string, unknown>>(`/api/transactions/${id}`)
      await api(`/api/transactions/${id}/investigate`, { method: 'POST', headers: { 'Idempotency-Key': `inv-${user?.id}-${id}` } })
      return row as {
        transactionId: string
        createdAt: string
        customerId: string
        amount: number
        currency: string
        paymentMethod: PaymentMethod
        status: string
        responseTimeMs: number
        riskScore: number
        failureReason: string | null
        apiEndpoint: string
        correlationId: string
        settlementStatus: string
        notificationStatus: string
        institution: { name: string }
        merchant: { name: string }
        timeline: Array<{ id: string; timestamp: string; service: string; event: string; status: string }>
      }
    },
  })
  if (query.isLoading) return <Skeleton className="h-80" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={(query.error as { message: string }).message} />
  const row = query.data!
  const fields = [
    ['Transaction', row.transactionId],
    ['Timestamp', new Date(row.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })],
    ['Customer', row.customerId],
    ['Merchant', row.merchant?.name],
    ['Bank', row.institution?.name],
    ['Amount', formatNpr(row.amount)],
    ['Currency', row.currency],
    ['Method', PAYMENT_LABEL[row.paymentMethod]],
    ['Status', row.status],
    ['Response', formatDuration(row.responseTimeMs)],
    ['Risk', String(row.riskScore)],
    ['Failure reason', row.failureReason ?? '—'],
    ['API', row.apiEndpoint],
    ['Correlation', row.correlationId],
    ['Settlement', row.settlementStatus],
    ['Notification', row.notificationStatus],
  ]
  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
      <div>
        <Link to="/transactions" className="text-sm text-blue-700">Back to transactions</Link>
        <h1 className="mt-2 text-xl font-semibold">{row.transactionId}</h1>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          {fields.map(([label, value]) => <div key={label} className="rounded-md border border-line bg-card p-3"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 text-sm font-medium">{label === 'Status' ? <StatusBadge status={String(value)} /> : value}</dd></div>)}
        </dl>
      </div>
      <section className="rounded-lg border border-line bg-card p-4">
        <h2 className="text-sm font-semibold">Timeline</h2>
        <ol className="mt-3 space-y-3">
          {row.timeline.map((event) => (
            <li key={event.id} className="border-l-2 border-line pl-3">
              <p className="text-xs text-muted">{new Date(event.timestamp).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kathmandu', hour12: false })} · {event.service}</p>
              <p className="text-sm">{event.event}</p>
              <StatusBadge status={event.status} />
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
