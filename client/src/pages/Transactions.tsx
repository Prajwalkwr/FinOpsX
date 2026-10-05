import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { can, formatCount, formatNpr, PAYMENT_LABEL, PAYMENT_METHODS, type PaymentMethod } from '@finopsx/shared'
import { api, download, errorMessage, idem } from '../api'
import { useAuth, useToast } from '../contexts'
import { fmtDateTime, fmtMs, fmtTime, humanize, queryString, useUrlFilters } from '../lib/format'
import { Button, Card, Drawer, EmptyState, ErrorState, PageHeader, Pagination, Select, Skeleton, StatusBadge, Table, useDebounced } from '../components/ui'

type Row = {
  transactionId: string
  createdAt: string
  amount: number
  paymentMethod: PaymentMethod
  status: string
  responseTimeMs: number
  responseCode: string
  failureReason: string | null
  settlementStatus: string
  institution: { name: string; code: string } | null
  merchant: { name: string } | null
}
type Page = { items: Row[]; page: number; totalPages: number; total: number }

const STATUSES = ['ALL', 'SUCCESSFUL', 'SUCCESS', 'SETTLED', 'FAILED', 'PENDING', 'PROCESSING', 'INITIATED', 'REVERSED']
const INSTITUTIONS: Array<[string, string]> = [['', 'All institutions'], ['DBA', 'Demo Bank A'], ['DBB', 'Demo Bank B'], ['DBC', 'Demo Bank C'], ['DWL', 'Demo Wallet'], ['DPN', 'Demo Payment Network'], ['DMN', 'Demo Merchant Network']]
const RANGES: Array<[string, string]> = [['24h', 'Last 24 hours'], ['1h', 'Last hour'], ['6h', 'Last 6 hours'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']]
const REASONS = ['', 'TIMEOUT', 'BANK_API_ERROR', 'INSUFFICIENT_FUNDS', 'NETWORK_ERROR', 'INVALID_REQUEST', 'SERVICE_UNAVAILABLE', 'DUPLICATE_TRANSACTION', 'AUTHENTICATION_FAILURE', 'SETTLEMENT_DELAY']
const SETTLEMENT = ['', 'NOT_STARTED', 'QUEUED', 'SETTLED', 'DELAYED', 'FAILED']
const DEFAULTS = { status: 'ALL', institution: '', paymentMethod: '', range: '24h', failureReason: '', settlementStatus: '', minAmount: '', maxAmount: '', q: '', sort: 'createdAt', dir: 'desc', page: '1' }

export function TransactionsPage() {
  const toast = useToast()
  const [filters, setFilters] = useUrlFilters(DEFAULTS)
  const [search, setSearch] = useState(filters.q)
  const [drawer, setDrawer] = useState(false)
  const debounced = useDebounced(search, 350)
  useEffect(() => { if (debounced !== filters.q) setFilters({ q: debounced }) }, [debounced]) // eslint-disable-line react-hooks/exhaustive-deps

  const params = queryString({ ...filters, limit: 25 })
  const query = useQuery({ queryKey: ['transactions', params], queryFn: () => api<Page>(`/api/transactions?${params}`), placeholderData: (previous) => previous })
  const exportParams = queryString({ ...filters, page: undefined, sort: undefined, dir: undefined })

  const filterControls = (
    <>
      <Select label="Status" value={filters.status} onChange={(status) => setFilters({ status })} options={STATUSES.map((item) => [item, item === 'ALL' ? 'All statuses' : item === 'SUCCESSFUL' ? 'Successful (incl. settled)' : humanize(item)] as [string, string])} />
      <Select label="Institution" value={filters.institution} onChange={(institution) => setFilters({ institution })} options={INSTITUTIONS} />
      <Select label="Payment method" value={filters.paymentMethod} onChange={(paymentMethod) => setFilters({ paymentMethod })} options={[['', 'All methods'], ...PAYMENT_METHODS.map((item) => [item, PAYMENT_LABEL[item]] as [string, string])]} />
      <Select label="Time range" value={filters.range} onChange={(range) => setFilters({ range })} options={RANGES} />
      <Select label="Failure reason" value={filters.failureReason} onChange={(failureReason) => setFilters({ failureReason })} options={REASONS.map((item) => [item, item ? humanize(item) : 'Any failure reason'] as [string, string])} />
      <Select label="Settlement status" value={filters.settlementStatus} onChange={(settlementStatus) => setFilters({ settlementStatus })} options={SETTLEMENT.map((item) => [item, item ? humanize(item) : 'Any settlement status'] as [string, string])} />
      <label className="text-xs text-muted">Min Rs.<input className="ml-1 w-24 rounded-full border border-line bg-card px-3 py-1.5 text-sm text-ink" inputMode="numeric" value={filters.minAmount} onChange={(event) => setFilters({ minAmount: event.target.value.replace(/[^\d]/g, '') })} aria-label="Minimum amount" /></label>
      <label className="text-xs text-muted">Max Rs.<input className="ml-1 w-24 rounded-full border border-line bg-card px-3 py-1.5 text-sm text-ink" inputMode="numeric" value={filters.maxAmount} onChange={(event) => setFilters({ maxAmount: event.target.value.replace(/[^\d]/g, '') })} aria-label="Maximum amount" /></label>
      <Select label="Sort by" value={`${filters.sort}:${filters.dir}`} onChange={(value) => { const [sort, dir] = value.split(':'); setFilters({ sort, dir }) }} options={[['createdAt:desc', 'Newest first'], ['createdAt:asc', 'Oldest first'], ['amount:desc', 'Largest amount'], ['responseTimeMs:desc', 'Slowest response']]} />
    </>
  )

  return (
    <div>
      <PageHeader
        title="Transactions"
        description="Synthetic payment transactions with server-side filtering. Customer IDs are masked."
        actions={(
          <>
            <input aria-label="Search transactions" className="w-64 rounded-full border border-line bg-card px-3 py-2 text-sm" placeholder="Transaction ID, correlation, customer" value={search} onChange={(event) => setSearch(event.target.value)} />
            <Button variant="ghost" className="lg:hidden" onClick={() => setDrawer(true)}>Filters</Button>
            <Button variant="ghost" onClick={async () => { try { await download(`/api/transactions/export?${exportParams}`); toast.push('CSV exported (up to 10,000 rows).') } catch (error) { toast.push(errorMessage(error), 'err') } }}>Export CSV</Button>
          </>
        )}
      />
      <div className="mb-3 hidden flex-wrap items-center gap-2 lg:flex">{filterControls}<Button variant="quiet" onClick={() => { setSearch(''); setFilters({ ...DEFAULTS }) }}>Clear</Button></div>
      {drawer ? <Drawer title="Filters" onClose={() => setDrawer(false)}><div className="grid gap-3">{filterControls}<Button onClick={() => setDrawer(false)}>Apply</Button></div></Drawer> : null}
      {query.isLoading ? <Skeleton className="h-64" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.items.length ? (
        <>
          <Table head={['Transaction', 'Time', 'Bank', 'Merchant', 'Amount', 'Method', 'Status', 'Response', 'Settlement']} minWidth={980}>
            {query.data.items.map((row) => (
              <tr key={row.transactionId}>
                <td><Link className="font-medium text-brand" to={`/transactions/${row.transactionId}`}>{row.transactionId}</Link></td>
                <td className="whitespace-nowrap text-muted">{fmtDateTime(row.createdAt)}</td>
                <td>{row.institution?.name}</td>
                <td>{row.merchant?.name}</td>
                <td className="tabular-nums">{formatNpr(row.amount)}</td>
                <td>{PAYMENT_LABEL[row.paymentMethod]}</td>
                <td><StatusBadge status={row.status} />{row.failureReason ? <p className="mt-0.5 text-[11px] text-muted">{humanize(row.failureReason)}</p> : null}</td>
                <td className="tabular-nums">{fmtMs(row.responseTimeMs)} <span className="text-[11px] text-muted">({row.responseCode})</span></td>
                <td><StatusBadge status={row.settlementStatus} /></td>
              </tr>
            ))}
          </Table>
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={(page) => setFilters({ page: String(page) })} />
          <p className="mt-2 text-xs text-muted">{formatCount(query.data.total)} matching transactions.</p>
        </>
      ) : <EmptyState title="No transactions match these filters." detail="Widen the time range or clear a filter." />}
    </div>
  )
}

type Detail = {
  transactionId: string
  createdAt: string
  customerId: string
  amount: number
  currency: string
  paymentMethod: PaymentMethod
  status: string
  responseTimeMs: number
  responseCode: string
  riskScore: number
  failureReason: string | null
  failureDescription: string | null
  apiEndpoint: string
  correlationId: string
  merchantReference: string | null
  settlementStatus: string
  notificationStatus: string
  lifecycleStage: string
  institution: { id: string; name: string; code: string }
  destinationInstitution: { name: string } | null
  merchant: { name: string }
  stageTimestamps: Record<string, string | null>
  lifecycle: Array<{ stage: string; label: string; status: string; at: string | null; detail: string | null; sincePreviousMs: number | null }>
  timeline: Array<{ id: string; service: string; event: string; status: string; timestamp: string }>
  settlement: { id: string; status: string; amount: number; transactionCount: number; settledAt: string | null } | null
  institutionRecord: { reference: string; amount: number; status: string; recordedAt: string } | null
  ledgerMatch: string
  duplicateCorrelationCount: number
  apiCalls: Array<{ endpoint: string; statusCode: number; latencyMs: number; at: string }>
}

function stageColor(status: string) {
  if (status === 'failed') return 'border-red-500 bg-red-500'
  if (status === 'done') return 'border-emerald-500 bg-emerald-500'
  if (status === 'pending') return 'border-amber-500 bg-amber-300'
  if (status === 'warning') return 'border-amber-600 bg-amber-600'
  return 'border-line bg-card'
}

export function TransactionDetailPage() {
  const { id = '' } = useParams()
  const { user } = useAuth()
  const query = useQuery({ queryKey: ['transaction', id], queryFn: () => api<Detail>(`/api/transactions/${id}`) })
  useEffect(() => {
    if (user && can(user.role, 'transactions:investigate')) {
      api(`/api/transactions/${id}/investigate`, { method: 'POST', headers: idem(`inv-${id}`) }).catch(() => undefined)
    }
  }, [id, user])
  if (query.isLoading) return <Skeleton className="h-80" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} />
  const row = query.data!
  const fields: Array<[string, React.ReactNode]> = [
    ['Created', fmtDateTime(row.createdAt)],
    ['Amount', `${formatNpr(row.amount)} ${row.currency}`],
    ['Payment method', PAYMENT_LABEL[row.paymentMethod]],
    ['Source institution', <Link key="i" className="text-brand" to={`/institutions/${row.institution.id}`}>{row.institution.name}</Link>],
    ['Destination', row.destinationInstitution?.name ?? '—'],
    ['Merchant', row.merchant.name],
    ['Customer (masked)', row.customerId],
    ['Response', `${fmtMs(row.responseTimeMs)} · code ${row.responseCode}`],
    ['Failure reason', row.failureReason ? `${humanize(row.failureReason)}${row.failureDescription ? ` — ${row.failureDescription}` : ''}` : '—'],
    ['API endpoint', row.apiEndpoint],
    ['Correlation ID', <span key="c" className="break-all font-mono text-xs">{row.correlationId}</span>],
    ['Merchant reference', row.merchantReference ?? 'Missing'],
    ['Settlement', <StatusBadge key="s" status={row.settlementStatus} />],
    ['Notification', <StatusBadge key="n" status={row.notificationStatus} />],
    ['Risk score', String(row.riskScore)],
  ]
  return (
    <div className="space-y-4">
      <Link to="/transactions" className="text-sm text-brand">← Transactions</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{row.transactionId}</h1>
        <StatusBadge status={row.status} />
        {row.duplicateCorrelationCount > 0 ? <StatusBadge status="DUPLICATE_CORRELATION_ID" /> : null}
      </div>

      <Card title="Lifecycle">
        <ol className="grid gap-3 md:grid-cols-6" aria-label="Transaction lifecycle">
          {row.lifecycle.map((stage, index) => (
            <li key={stage.stage} className="relative">
              <div className="flex items-center gap-2">
                <span className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${stageColor(stage.status)}`} aria-hidden="true" />
                {index < row.lifecycle.length - 1 ? <span className="hidden h-0.5 flex-1 bg-line md:block" aria-hidden="true" /> : null}
              </div>
              <p className="mt-2 text-sm font-medium">{stage.label}</p>
              <p className="text-xs text-muted">{stage.at ? fmtTime(stage.at) : 'Not reached'}{stage.sincePreviousMs != null ? ` · +${fmtMs(stage.sincePreviousMs)}` : ''}</p>
              <p className="text-[11px] text-muted">{humanize(stage.status)}{stage.detail ? ` — ${stage.detail}` : ''}</p>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[11px] text-muted">Stages and times come from recorded lifecycle timestamps and events; stages without a record show as not reached.</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
        <Card title="Details">
          <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            {fields.map(([label, value]) => <div key={label}><dt className="text-xs text-muted">{label}</dt><dd className="mt-0.5 text-sm">{value}</dd></div>)}
          </dl>
        </Card>
        <div className="space-y-4">
          <Card title="Reconciliation">
            <p className="text-sm">Ledger match: <StatusBadge status={row.ledgerMatch} /></p>
            {row.institutionRecord ? (
              <p className="mt-2 text-sm text-muted">Institution record {row.institutionRecord.reference}: {formatNpr(row.institutionRecord.amount)} ({humanize(row.institutionRecord.status)}) at {fmtDateTime(row.institutionRecord.recordedAt)}</p>
            ) : <p className="mt-2 text-sm text-muted">No institution-side record found for this transaction.</p>}
            {row.settlement ? (
              <p className="mt-2 text-sm text-muted">Settlement batch {row.settlement.id}: {humanize(row.settlement.status)}, {row.settlement.transactionCount} transactions, {formatNpr(row.settlement.amount)}{row.settlement.settledAt ? `, settled ${fmtDateTime(row.settlement.settledAt)}` : ''}.</p>
            ) : <p className="mt-2 text-sm text-muted">Not yet in a settlement batch.</p>}
          </Card>
          <Card title="API calls">
            {row.apiCalls.length ? (
              <ul className="space-y-1 text-sm">
                {row.apiCalls.map((call, index) => <li key={index} className="flex justify-between gap-2"><span className="font-mono text-xs">{call.endpoint}</span><span className={`tabular-nums ${call.statusCode >= 500 ? 'text-red-700 dark:text-red-300' : call.statusCode >= 400 ? 'text-amber-700' : 'text-muted'}`}>{call.statusCode} · {fmtMs(call.latencyMs)}</span></li>)}
              </ul>
            ) : <p className="text-sm text-muted">No API call records are retained for this transaction (calls are kept for 6 hours).</p>}
          </Card>
        </div>
      </div>

      <Card title="Event log">
        {row.timeline.length ? (
          <ol className="space-y-2">
            {row.timeline.map((event) => (
              <li key={event.id} className="border-l-2 border-line pl-3">
                <p className="text-xs text-muted">{fmtTime(event.timestamp)} · {event.service}</p>
                <p className="text-sm">{event.event} <StatusBadge status={event.status} /></p>
              </li>
            ))}
          </ol>
        ) : <p className="text-sm text-muted">No event records stored for this transaction.</p>}
      </Card>
    </div>
  )
}

