import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { Button, inputClass } from '../components/ui'

const PROMPTS = [
  'Analyze today\'s failures',
  'Find unusual activity',
  'Compare institutions',
  'Explain current incidents',
  'Generate daily report',
  'Find slow APIs',
  'Which institution has the highest failure rate?',
]

type ChatResponse = {
  conversationId: string
  notice: string | null
  provider: string
  reportId?: string | null
  table?: { columns: string[]; rows: string[][] } | null
  message: { content: string }
}

export function AssistantPage() {
  const client = useQueryClient()
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const history = useQuery({ queryKey: ['ai', conversationId], enabled: Boolean(conversationId), queryFn: () => api<{ id: string; title: string; messages: Array<{ id: string; role: string; content: string; tool: string | null }> }>(`/api/ai/conversations/${conversationId}`) })
  const conversations = useQuery({ queryKey: ['ai-list'], queryFn: () => api<Array<{ id: string; title: string }>>('/api/ai/conversations') })
  const [last, setLast] = useState<ChatResponse | null>(null)
  const send = useMutation({
    mutationFn: (message: string) => api<ChatResponse>('/api/ai/chat', {
      method: 'POST',
      headers: { 'Idempotency-Key': `ai-${conversationId ?? 'new'}-${message.slice(0, 24)}-${Date.now()}` },
      body: JSON.stringify({ message, conversationId }),
    }),
    onSuccess: (result) => {
      setConversationId(result.conversationId)
      setLast(result)
      setText('')
      client.invalidateQueries({ queryKey: ['ai', result.conversationId] })
      client.invalidateQueries({ queryKey: ['ai-list'] })
    },
  })

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <aside className="rounded-lg border border-line bg-card p-3">
        <Button className="mb-3 w-full" onClick={async () => { const row = await api<{ id: string }>('/api/ai/conversations', { method: 'POST', body: JSON.stringify({ title: 'New conversation' }) }); setConversationId(row.id); setLast(null); conversations.refetch() }}>New conversation</Button>
        <ul className="space-y-1 text-sm">
          {conversations.data?.map((item) => <li key={item.id}><button className={`w-full rounded px-2 py-1 text-left ${item.id === conversationId ? 'bg-slate-100 dark:bg-white/10' : ''}`} onClick={() => { setConversationId(item.id); setLast(null) }}>{item.title}</button></li>)}
        </ul>
      </aside>
      <section className="flex min-h-[70vh] flex-col rounded-lg border border-line bg-card">
        <header className="border-b border-line p-4">
          <h1 className="text-lg font-semibold">F1 AI Operations Assistant</h1>
          <p className="text-sm text-muted">Ask questions about your operational data.</p>
          {conversationId ? <form className="mt-2 flex gap-2" onSubmit={async (event) => { event.preventDefault(); await api(`/api/ai/conversations/${conversationId}`, { method: 'PATCH', body: JSON.stringify({ title }) }); conversations.refetch() }}><input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Rename conversation" /><Button type="submit" variant="ghost">Rename</Button><Button type="button" variant="ghost" onClick={async () => { await api(`/api/ai/conversations/${conversationId}`, { method: 'DELETE' }); setConversationId(undefined); conversations.refetch() }}>Delete</Button></form> : null}
        </header>
        <div className="flex-1 space-y-3 overflow-auto p-4">
          {last?.notice ? <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{last.notice}</p> : null}
          {history.data?.messages.map((message) => <article key={message.id} className={`max-w-[46rem] rounded-lg px-3 py-2 text-sm ${message.role === 'user' ? 'ml-auto bg-brand text-white' : 'bg-slate-100 dark:bg-white/5'}`}><p className="whitespace-pre-wrap">{message.content}</p>{message.tool ? <p className="mt-1 text-[11px] opacity-70">Tool {message.tool}</p> : null}</article>)}
          {send.isError ? <p className="text-sm text-red-700">{(send.error as { message: string }).message}</p> : null}
          {last?.table ? <div className="table-wrap"><table className="w-full text-left text-sm"><thead>{last.table.columns.map((column) => <th key={column} className="p-1">{column}</th>)}</thead><tbody>{last.table.rows.map((row, index) => <tr key={index}>{row.map((cell) => <td key={cell} className="border-t border-line p-1">{cell}</td>)}</tr>)}</tbody></table></div> : null}
          {last?.reportId ? <a className="text-sm text-blue-700" href="/reports">Report created. Open reports to download it.</a> : null}
        </div>
        <div className="border-t border-line p-3">
          <div className="mb-2 flex gap-2 overflow-auto">{PROMPTS.map((prompt) => <button key={prompt} className="whitespace-nowrap rounded-full border border-line px-3 py-1 text-xs" onClick={() => send.mutate(prompt)}>{prompt}</button>)}</div>
          <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (text.trim()) send.mutate(text.trim()) }}>
            <input className={inputClass} aria-label="Ask the assistant" value={text} onChange={(event) => setText(event.target.value)} placeholder="Which institution has the highest failure rate?" />
            <Button type="submit" disabled={send.isPending}>{send.isPending ? 'Asking…' : 'Ask'}</Button>
          </form>
        </div>
      </section>
    </div>
  )
}
