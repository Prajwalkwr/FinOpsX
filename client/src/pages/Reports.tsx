import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { can, REPORT_LABEL, type ReportType } from '@finopsx/shared'
import { api, download } from '../api'
import { useAuth, useToast } from '../contexts'
import { Button, Card, ConfirmDialog, ErrorState, Skeleton } from '../components/ui'

const TYPES = Object.keys(REPORT_LABEL) as ReportType[]

export function ReportsPage() {
  const { user } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [type, setType] = useState<ReportType>('DAILY_OPERATIONS')
  const [busy, setBusy] = useState(false)
  const [remove, setRemove] = useState<string | null>(null)
  const query = useQuery({ queryKey: ['reports'], queryFn: () => api<{ items: Array<{ id: string; title: string; type: string; deliveryStatus: string; createdAt: string }> }>('/api/reports?page=1&limit=25') })
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => api<Array<{ cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY'; enabled: boolean; email: string }>>('/api/reports/schedules') })
  if (query.isLoading) return <Skeleton className="h-48" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Reports</h1>
      {user && can(user.role, 'reports:generate') ? (
        <Card title="Generate">
          <div className="flex flex-wrap gap-2">
            <select className="rounded border border-line bg-card px-2 py-2 text-sm" value={type} onChange={(event) => setType(event.target.value as ReportType)} aria-label="Report type">{TYPES.map((item) => <option key={item} value={item}>{REPORT_LABEL[item]}</option>)}</select>
            <Button disabled={busy} onClick={async () => {
              setBusy(true)
              try {
                await api('/api/reports', { method: 'POST', headers: { 'Idempotency-Key': `report-${type}-${Date.now()}` }, body: JSON.stringify({ type }) })
                toast.push('Report generated')
                client.invalidateQueries({ queryKey: ['reports'] })
              } catch (error) { toast.push((error as { message: string }).message, 'err') } finally { setBusy(false) }
            }}>{busy ? 'Generating…' : 'Generate report'}</Button>
          </div>
        </Card>
      ) : null}
      <div className="grid gap-3">
        {query.data?.items.map((report) => (
          <article key={report.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-card p-4">
            <div><h2 className="font-medium">{report.title}</h2><p className="text-xs text-muted">{report.deliveryStatus} · {new Date(report.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' })}</p></div>
            <div className="flex gap-2">
              {(['pdf', 'csv', 'xlsx'] as const).map((format) => <Button key={format} variant="ghost" onClick={async () => { await download(`/api/reports/${report.id}/download?format=${format}`); toast.push(`Exported ${format.toUpperCase()}`) }}>{format.toUpperCase()}</Button>)}
              {user && can(user.role, 'reports:delete') ? <Button variant="danger" onClick={() => setRemove(report.id)}>Delete</Button> : null}
            </div>
          </article>
        ))}
      </div>
      {user && can(user.role, 'settings:security') ? (
        <Card title="Schedules">
          <p className="mb-2 text-sm text-muted">{schedules.data?.[0]?.email}</p>
          {schedules.data?.map((schedule) => <label key={schedule.cadence} className="mr-4 text-sm"><input type="checkbox" className="mr-1" checked={schedule.enabled} onChange={async (event) => { await api(`/api/reports/schedules/${schedule.cadence}`, { method: 'PUT', body: JSON.stringify({ enabled: event.target.checked }) }); schedules.refetch(); toast.push('Schedule saved') }} />{schedule.cadence}</label>)}
        </Card>
      ) : null}
      {remove ? <ConfirmDialog title="Delete report" body="Delete this generated report?" confirmLabel="Delete" danger onClose={() => setRemove(null)} onConfirm={async () => { await api(`/api/reports/${remove}`, { method: 'DELETE' }); setRemove(null); toast.push('Report deleted'); client.invalidateQueries({ queryKey: ['reports'] }) }} /> : null}
    </div>
  )
}
