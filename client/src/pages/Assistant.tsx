import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Download, Send, Trash2 } from 'lucide-react'
import { can, type AiAction } from '@finopsx/shared'
import { api, download, errorMessage, idem } from '../api'
import { useAuth, useToast } from '../contexts'
import { fmtDateTime, humanize } from '../lib/format'
import { Badge, Button, Card, EmptyState, Field, inputClass, PageHeader, Table } from '../components/ui'

const PROMPTS = [
  'Give me an overview of today',
  'Why did failures increase in the last hour?',
  'Explain current incidents',
  'Find unusual activity',
  'Which institution has the highest failure rate today?',
  'Which APIs are slowest?',
  'Show settlement and reconciliation status',
  'Generate daily report',
]

type Cell = string | number | null
type ChatMessage = { id: string; role: string; content: string; tool: string | null; actions?: AiAction[] | null; createdAt: string }
type ChatResponse = {
  conversationId: string
  notice: string | null
  provider: string
  status: string
  reportId: string | null
  table: { columns: string[]; rows: Cell[][] } | null
  actions: AiAction[]
  message: ChatMessage
}

export function AssistantPage() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const showAskData = Boolean(user && can(user.role, 'askdata:use'))
  const tab = showAskData && params.get('tab') === 'ask-data' ? 'ask-data' : 'chat'
  return (
    <div>
      <PageHeader
        title="FinOpsX AI Operations Assistant"
        description="Answers come from live synthetic platform data through permission-checked tools. It never runs SQL, moves money or changes records. When data is missing it says so."
      />
      {showAskData ? (
        <div className="mb-4 inline-flex rounded-full border border-line bg-card p-1 text-sm" role="tablist">
          <button role="tab" aria-selected={tab === 'chat'} className={`rounded-full px-4 py-1.5 ${tab === 'chat' ? 'bg-brand text-white' : ''}`} onClick={() => setParams({}, { replace: true })}>Assistant</button>
          <button role="tab" aria-selected={tab === 'ask-data'} className={`rounded-full px-4 py-1.5 ${tab === 'ask-data' ? 'bg-brand text-white' : ''}`} onClick={() => setParams({ tab: 'ask-data' }, { replace: true })}>Ask Your Data</button>
        </div>
      ) : null}
      {tab === 'chat' ? <Chat /> : <AskYourData />}
    </div>
  )
}

function Chat() {
  const client = useQueryClient()
  const toast = useToast()
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [text, setText] = useState('')
  const [extras, setExtras] = useState<Record<string, Pick<ChatResponse, 'table' | 'reportId' | 'status'>>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const conversations = useQuery({ queryKey: ['ai', 'list'], queryFn: () => api<Array<{ id: string; title: string; updatedAt: string }>>('/api/ai/conversations') })
  const history = useQuery({ queryKey: ['ai', 'conversation', conversationId], enabled: Boolean(conversationId), queryFn: () => api<{ id: string; title: string; messages: ChatMessage[] }>(`/api/ai/conversations/${conversationId}`) })
  const send = useMutation({
    mutationFn: (message: string) => api<ChatResponse>('/api/ai/chat', { method: 'POST', headers: idem('ai'), body: JSON.stringify({ message, conversationId }) }),
    onSuccess: (result) => {
      setConversationId(result.conversationId)
      setExtras((current) => ({ ...current, [result.message.id]: { table: result.table, reportId: result.reportId, status: result.status } }))
      setNotice(result.notice)
      setText('')
      client.invalidateQueries({ queryKey: ['ai', 'conversation', result.conversationId] })
      client.invalidateQueries({ queryKey: ['ai', 'list'] })
      if (result.reportId) client.invalidateQueries({ queryKey: ['reports'] })
    },
  })

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [history.data?.messages.length, send.isPending])

  async function remove(id: string) {
    try {
      await api(`/api/ai/conversations/${id}`, { method: 'DELETE' })
      if (id === conversationId) setConversationId(undefined)
      conversations.refetch()
    } catch (error) { toast.push(errorMessage(error), 'err') }
  }

  const messages = history.data?.messages ?? []
  const pendingMessage = send.isPending ? send.variables : null
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="min-w-0 rounded-3xl border border-line bg-card p-3">
        <Button className="mb-3 w-full" onClick={() => { setConversationId(undefined); setNotice(null) }}>New conversation</Button>
        {conversations.data?.length ? (
          <ul className="space-y-1 text-sm">
            {conversations.data.map((item) => (
              <li key={item.id} className="group flex items-center gap-1">
                <button className={`min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left ${item.id === conversationId ? 'bg-slate-100 font-medium dark:bg-white/10' : 'hover:bg-slate-50 dark:hover:bg-white/5'}`} onClick={() => setConversationId(item.id)} title={item.title}>{item.title}</button>
                <button aria-label={`Delete conversation ${item.title}`} className="rounded p-1 text-muted opacity-60 hover:text-red-600 group-hover:opacity-100" onClick={() => remove(item.id)}><Trash2 className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>
        ) : <p className="px-2 text-xs text-muted">No conversations yet.</p>}
      </aside>
      <section className="flex min-h-[65vh] min-w-0 flex-col rounded-3xl border border-line bg-card">
        <div ref={scroller} className="flex-1 space-y-3 overflow-auto p-4" aria-live="polite">
          {notice ? <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">{notice}</p> : null}
          {!messages.length && !pendingMessage ? (
            <div className="grid place-items-center py-16 text-center">
              <Bot className="h-10 w-10 text-brand" aria-hidden />
              <p className="mt-3 font-medium">Ask about transactions, incidents, anomalies, APIs, settlements, jobs or data quality.</p>
              <p className="mt-1 max-w-md text-sm text-muted">Every answer lists its evidence, recommended next steps and links into the platform. Answers only use data your role can see.</p>
            </div>
          ) : null}
          {messages.map((message) => <MessageBubble key={message.id} message={message} extra={extras[message.id]} />)}
          {pendingMessage ? (
            <>
              <article className="ml-auto max-w-[46rem] rounded-2xl bg-brand px-3 py-2 text-sm text-white"><p className="whitespace-pre-wrap">{pendingMessage}</p></article>
              <p className="text-sm text-muted">Analysing live data…</p>
            </>
          ) : null}
          {send.isError ? <p className="text-sm text-red-700 dark:text-red-300" role="alert">{errorMessage(send.error)}</p> : null}
        </div>
        <div className="border-t border-line p-3">
          <div className="mb-2 flex flex-wrap gap-2">
            {PROMPTS.map((prompt) => <button key={prompt} disabled={send.isPending} className="rounded-full border border-line px-3 py-1 text-xs hover:bg-slate-50 disabled:opacity-50 dark:hover:bg-white/5" onClick={() => send.mutate(prompt)}>{prompt}</button>)}
          </div>
          <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (text.trim().length >= 2) send.mutate(text.trim()) }}>
            <input className={inputClass} aria-label="Ask the assistant" value={text} maxLength={2000} onChange={(event) => setText(event.target.value)} placeholder="Why are Demo Bank B payments failing?" />
            <Button type="submit" disabled={send.isPending || text.trim().length < 2} aria-label="Send"><Send className="h-4 w-4" /></Button>
          </form>
        </div>
      </section>
    </div>
  )
}

function MessageBubble({ message, extra }: { message: ChatMessage; extra?: Pick<ChatResponse, 'table' | 'reportId' | 'status'> }) {
  if (message.role === 'user') {
    return <article className="ml-auto max-w-[46rem] rounded-2xl bg-brand px-3 py-2 text-sm text-white"><p className="whitespace-pre-wrap">{message.content}</p></article>
  }
  const actions = Array.isArray(message.actions) ? message.actions : []
  return (
    <article className="max-w-[52rem] rounded-2xl border border-line bg-[#f7f9fc] px-4 py-3 text-sm dark:bg-white/5">
      <div className="space-y-1">
        {message.content.split('\n').map((line, index) => {
          if (!line.trim()) return <div key={index} className="h-1" />
          if (/^(Summary|Limitation):/.test(line)) {
            const [head, ...rest] = line.split(':')
            return <p key={index} className={head === 'Limitation' ? 'pt-1 text-[11px] text-amber-700 dark:text-amber-300' : ''}><strong>{head}:</strong>{rest.join(':')}</p>
          }
          if (/^(Evidence|Recommended next steps):$/.test(line)) return <p key={index} className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted">{line.replace(':', '')}</p>
          if (line.startsWith('- ')) return <p key={index} className="pl-3 before:mr-2 before:content-['•']">{line.slice(2)}</p>
          return <p key={index} className="whitespace-pre-wrap">{line}</p>
        })}
      </div>
      {extra?.table ? (
        <div className="mt-3">
          <Table head={extra.table.columns} minWidth={420}>
            {extra.table.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{formatCell(cell)}</td>)}</tr>)}
          </Table>
        </div>
      ) : null}
      {actions.length || extra?.reportId ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {extra?.reportId ? <Link to={`/reports/${extra.reportId}`} className="rounded-full bg-brand px-3 py-1 text-xs text-white">Open generated report</Link> : null}
          {actions.map((action) => <Link key={action.href + action.label} to={action.href} className="rounded-full border border-line bg-card px-3 py-1 text-xs text-brand hover:bg-[#eef3ff] dark:hover:bg-white/10">{action.label} →</Link>)}
        </div>
      ) : null}
      <p className="mt-2 text-[11px] text-muted">{message.tool ? `Tool: ${humanize(message.tool.replace(/([A-Z])/g, '_$1'))} · ` : ''}{fmtDateTime(message.createdAt)}</p>
    </article>
  )
}

function formatCell(cell: Cell) {
  if (cell == null) return '—'
  if (typeof cell === 'number') return Number.isInteger(cell) ? cell.toLocaleString('en-US') : cell.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (/^\d{4}-\d{2}-\d{2}T/.test(cell)) return fmtDateTime(cell)
  return cell
}

/* ------------------------------------------------------------ Ask Your Data */

const ENTITIES = ['transactions', 'incidents', 'anomalies', 'settlements', 'api_endpoints', 'jobs', 'data_quality'] as const
const METRICS = ['count', 'sum_amount', 'avg_amount', 'failure_rate', 'success_rate', 'avg_latency', 'p95_latency'] as const
const GROUP_BYS = ['institution', 'merchant', 'payment_method', 'status', 'failure_reason', 'hour', 'day', 'severity', 'type'] as const
const RANGES = ['1h', '6h', '24h', 'today', 'yesterday', '7d', '30d'] as const
const INSTITUTIONS: Array<[string, string]> = [['DBA', 'Demo Bank A'], ['DBB', 'Demo Bank B'], ['DBC', 'Demo Bank C'], ['DWL', 'Demo Wallet'], ['DPN', 'Demo Payment Network'], ['DMN', 'Demo Merchant Network']]
const TX_STATUSES = ['SUCCESS', 'SETTLED', 'FAILED', 'PENDING', 'REVERSED'] as const
const METHODS = ['QR', 'WALLET', 'BANK_TRANSFER', 'CARD', 'ACCOUNT_PAYMENT'] as const
const REASONS = ['TIMEOUT', 'BANK_API_ERROR', 'INSUFFICIENT_FUNDS', 'NETWORK_ERROR', 'INVALID_REQUEST', 'SERVICE_UNAVAILABLE', 'DUPLICATE_TRANSACTION', 'AUTHENTICATION_FAILURE', 'SETTLEMENT_DELAY'] as const
const SEVERITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

type StructuredQuery = {
  entity: (typeof ENTITIES)[number]
  mode: 'list' | 'aggregate'
  metric?: (typeof METRICS)[number]
  groupBy?: (typeof GROUP_BYS)[number]
  range: (typeof RANGES)[number]
  filters: { status?: string[]; institution?: string; paymentMethod?: string; failureReason?: string; minAmount?: number; maxAmount?: number; severity?: string; merchant?: string; activeOnly?: boolean }
  sort?: { field: 'createdAt' | 'amount' | 'metric'; dir: 'asc' | 'desc' }
  limit: number
}

type QueryResponse = {
  supported: boolean
  message: string
  query: StructuredQuery | null
  interpretation: string[]
  columns: string[]
  rows: Cell[][]
  rowLinks: Array<string | null>
  total: number
  summary?: string
  range?: { label: string }
  actions?: AiAction[]
}

const EXAMPLES = [
  'Failed transactions at Demo Bank B in the last hour',
  'Failure rate by institution today',
  'Average amount by payment method in the last 7 days',
  'Transactions above Rs. 1 lakh today',
  'Active incidents by severity',
  'Slowest APIs',
]

function AskYourData() {
  const toast = useToast()
  const [question, setQuestion] = useState('')
  const [draft, setDraft] = useState<StructuredQuery | null>(null)
  const [result, setResult] = useState<QueryResponse | null>(null)
  const [exporting, setExporting] = useState(false)
  const run = useMutation({
    mutationFn: (body: { question: string } | { query: StructuredQuery }) => api<QueryResponse>('/api/ai/query', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      setResult(data)
      if (data.query) setDraft(data.query)
    },
  })

  function patch(next: Partial<StructuredQuery>) {
    setDraft((current) => current ? { ...current, ...next } : current)
  }
  function patchFilter(next: Partial<StructuredQuery['filters']>) {
    setDraft((current) => {
      if (!current) return current
      const filters = { ...current.filters, ...next }
      for (const key of Object.keys(filters) as Array<keyof typeof filters>) if (filters[key] === undefined || filters[key] === '') delete filters[key]
      return { ...current, filters }
    })
  }

  async function exportCsv() {
    if (!draft) return
    setExporting(true)
    try {
      await download('/api/ai/query/export', { method: 'POST', body: { query: draft } })
    } catch (error) { toast.push(errorMessage(error), 'err') } finally { setExporting(false) }
  }

  const isTx = draft?.entity === 'transactions'
  return (
    <div className="space-y-4">
      <Card title="Ask a question about the data">
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); if (question.trim().length >= 3) run.mutate({ question: question.trim() }) }}>
          <input className={inputClass} aria-label="Question" value={question} maxLength={500} onChange={(event) => setQuestion(event.target.value)} placeholder="Failed transactions at Demo Bank B in the last hour" />
          <Button type="submit" disabled={run.isPending || question.trim().length < 3}>{run.isPending ? 'Running…' : 'Run'}</Button>
        </form>
        <div className="mt-2 flex flex-wrap gap-2">{EXAMPLES.map((example) => <button key={example} className="rounded-full border border-line px-3 py-1 text-xs hover:bg-slate-50 dark:hover:bg-white/5" onClick={() => { setQuestion(example); run.mutate({ question: example }) }}>{example}</button>)}</div>
        <p className="mt-3 text-xs text-muted">Your question is translated into a structured, whitelisted query (entity, metric, filters, range). The query is validated on the server and executed with parameterised database calls. Free-form SQL is never accepted.</p>
        {run.isError ? <p className="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">{errorMessage(run.error)}</p> : null}
      </Card>

      {result && !result.supported ? <Card><p className="text-sm">{result.message}</p></Card> : null}

      {draft ? (
        <Card title="Structured query" action={<Badge tone="info">editable · validated server-side</Badge>}>
          {result?.interpretation.length ? <ul className="mb-3 list-disc pl-5 text-xs text-muted">{result.interpretation.map((line) => <li key={line}>{line}</li>)}</ul> : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Entity"><select className={inputClass} value={draft.entity} onChange={(event) => patch({ entity: event.target.value as StructuredQuery['entity'], groupBy: undefined })}>{ENTITIES.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></Field>
            <Field label="Mode"><select className={inputClass} value={draft.mode} onChange={(event) => patch({ mode: event.target.value as StructuredQuery['mode'] })}><option value="list">List records</option><option value="aggregate">Aggregate</option></select></Field>
            <Field label="Range"><select className={inputClass} value={draft.range} onChange={(event) => patch({ range: event.target.value as StructuredQuery['range'] })}>{RANGES.map((item) => <option key={item}>{item}</option>)}</select></Field>
            <Field label="Row limit"><input type="number" min={1} max={200} className={inputClass} value={draft.limit} onChange={(event) => patch({ limit: Math.max(1, Math.min(200, Number(event.target.value) || 25)) })} /></Field>
            {draft.mode === 'aggregate' ? (
              <>
                <Field label="Metric"><select className={inputClass} value={draft.metric ?? 'count'} onChange={(event) => patch({ metric: event.target.value as StructuredQuery['metric'] })}>{METRICS.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></Field>
                <Field label="Group by"><select className={inputClass} value={draft.groupBy ?? ''} onChange={(event) => patch({ groupBy: (event.target.value || undefined) as StructuredQuery['groupBy'] })}><option value="">No grouping</option>{GROUP_BYS.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></Field>
              </>
            ) : null}
            {isTx || draft.entity === 'settlements' ? <Field label="Institution"><select className={inputClass} value={draft.filters.institution ?? ''} onChange={(event) => patchFilter({ institution: event.target.value || undefined })}><option value="">Any</option>{INSTITUTIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></Field> : null}
            {isTx ? (
              <>
                <Field label="Status"><select className={inputClass} value={draft.filters.status?.[0] ?? ''} onChange={(event) => patchFilter({ status: event.target.value ? [event.target.value] : undefined })}><option value="">Any</option>{TX_STATUSES.map((item) => <option key={item}>{item}</option>)}</select></Field>
                <Field label="Payment method"><select className={inputClass} value={draft.filters.paymentMethod ?? ''} onChange={(event) => patchFilter({ paymentMethod: event.target.value || undefined })}><option value="">Any</option>{METHODS.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></Field>
                <Field label="Failure reason"><select className={inputClass} value={draft.filters.failureReason ?? ''} onChange={(event) => patchFilter({ failureReason: event.target.value || undefined })}><option value="">Any</option>{REASONS.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></Field>
                <Field label="Min amount (NPR)"><input type="number" min={0} className={inputClass} value={draft.filters.minAmount ?? ''} onChange={(event) => patchFilter({ minAmount: event.target.value === '' ? undefined : Number(event.target.value) })} /></Field>
                <Field label="Max amount (NPR)"><input type="number" min={1} className={inputClass} value={draft.filters.maxAmount ?? ''} onChange={(event) => patchFilter({ maxAmount: event.target.value === '' ? undefined : Number(event.target.value) })} /></Field>
              </>
            ) : null}
            {draft.entity === 'incidents' || draft.entity === 'anomalies' ? (
              <>
                <Field label="Severity"><select className={inputClass} value={draft.filters.severity ?? ''} onChange={(event) => patchFilter({ severity: event.target.value || undefined })}><option value="">Any</option>{SEVERITY.map((item) => <option key={item}>{item}</option>)}</select></Field>
                <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={Boolean(draft.filters.activeOnly)} onChange={(event) => patchFilter({ activeOnly: event.target.checked || undefined })} />Active / open only</label>
              </>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => run.mutate({ query: draft })} disabled={run.isPending}>{run.isPending ? 'Running…' : 'Run query'}</Button>
            <Button variant="ghost" onClick={exportCsv} disabled={exporting || !result?.supported}><Download className="mr-1 inline h-4 w-4" />{exporting ? 'Exporting…' : 'Export CSV'}</Button>
          </div>
          <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">View query JSON</summary><pre className="mt-2 overflow-auto rounded-xl bg-slate-50 p-3 dark:bg-white/5">{JSON.stringify(draft, null, 2)}</pre></details>
        </Card>
      ) : null}

      {result?.supported ? (
        <Card title={`Results · ${result.total.toLocaleString('en-US')} match${result.total === 1 ? '' : 'es'}${result.range ? ` · ${result.range.label}` : ''}`}>
          <p className="mb-3 text-sm">{result.message}</p>
          {result.rows.length ? (
            <Table head={result.columns} minWidth={560}>
              {result.rows.map((row, index) => {
                const link = result.rowLinks[index]
                return (
                  <tr key={index}>
                    {row.map((cell, cellIndex) => <td key={cellIndex}>{cellIndex === 0 && link ? <Link className="text-brand" to={link}>{formatCell(cell)}</Link> : formatCell(cell)}</td>)}
                  </tr>
                )
              })}
            </Table>
          ) : <EmptyState title="No rows." detail="Try a wider range or fewer filters." />}
          {result.actions?.length ? <div className="mt-3 flex flex-wrap gap-2">{result.actions.map((action) => <Link key={action.href} to={action.href} className="rounded-full border border-line px-3 py-1 text-xs text-brand">{action.label} →</Link>)}</div> : null}
        </Card>
      ) : null}
    </div>
  )
}
