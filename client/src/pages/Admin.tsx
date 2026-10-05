import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Bell, CheckCheck, Download } from 'lucide-react'
import { can, ROLE_LABEL, ROLES, type PublicUser, type Role } from '@finopsx/shared'
import { api, download, errorMessage, idem } from '../api'
import { useAuth, useTheme, useToast } from '../contexts'
import { fmtDateTime, humanize, queryString, relTime, useUrlFilters } from '../lib/format'
import { Badge, Button, Card, ConfirmDialog, Drawer, EmptyState, ErrorState, Field, inputClass, PageHeader, Pagination, Select, Skeleton, StatusBadge, Table } from '../components/ui'

/* --------------------------------------------------------------- Audit logs */

type AuditRow = { id: string; userId: string | null; actorEmail: string; action: string; resource: string; resourceId: string | null; ipAddress: string | null; userAgent: string | null; previousValue: unknown; newValue: unknown; createdAt: string }

function toIso(local: string) {
  if (!local) return ''
  const date = new Date(local)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

export function AuditPage() {
  const toast = useToast()
  const [filters, setFilters] = useUrlFilters({ q: '', action: '', resource: '', from: '', to: '', page: '1' })
  const [selected, setSelected] = useState<AuditRow | null>(null)
  const [exporting, setExporting] = useState(false)
  const apiFilters = { q: filters.q, action: filters.action, resource: filters.resource, from: toIso(filters.from), to: toIso(filters.to) }
  const params = queryString({ ...apiFilters, page: filters.page, limit: 25 })
  const query = useQuery({ queryKey: ['audit', params], queryFn: () => api<{ items: AuditRow[]; page: number; totalPages: number; total: number; filters: { actions: string[]; resources: string[] } }>(`/api/audit-logs?${params}`), placeholderData: (previous) => previous })

  async function exportCsv() {
    setExporting(true)
    try {
      await download(`/api/audit-logs/export?${queryString(apiFilters)}`)
      toast.push('Audit log exported')
    } catch (error) { toast.push(errorMessage(error), 'err') } finally { setExporting(false) }
  }

  return (
    <div>
      <PageHeader
        title="Audit Logs"
        description="Every login, status change, assignment, export, simulator action and configuration change is recorded with the actor, IP address, user agent and before/after values. Entries cannot be edited."
        actions={<Button variant="ghost" onClick={exportCsv} disabled={exporting}><Download className="mr-1 inline h-4 w-4" />{exporting ? 'Exporting…' : 'Export CSV'}</Button>}
      />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <input aria-label="Search audit logs" className="rounded-full border border-line bg-card px-3 py-1.5 text-sm" placeholder="Actor, action or resource ID" value={filters.q} onChange={(event) => setFilters({ q: event.target.value })} />
        <Select label="Action" value={filters.action} onChange={(action) => setFilters({ action })} options={[['', 'Any action'], ...(query.data?.filters.actions ?? []).map((item) => [item, humanize(item)] as [string, string])]} />
        <Select label="Resource" value={filters.resource} onChange={(resource) => setFilters({ resource })} options={[['', 'Any resource'], ...(query.data?.filters.resources ?? []).map((item) => [item, humanize(item)] as [string, string])]} />
        <label className="text-xs text-muted">From <input type="datetime-local" className="ml-1 rounded-full border border-line bg-card px-2 py-1 text-sm" value={filters.from} onChange={(event) => setFilters({ from: event.target.value })} /></label>
        <label className="text-xs text-muted">To <input type="datetime-local" className="ml-1 rounded-full border border-line bg-card px-2 py-1 text-sm" value={filters.to} onChange={(event) => setFilters({ to: event.target.value })} /></label>
      </div>
      {query.isLoading ? <Skeleton className="h-64" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.items.length ? (
        <>
          <p className="mb-2 text-xs text-muted">{query.data.total.toLocaleString('en-US')} entries</p>
          <Table head={['When', 'Actor', 'Action', 'Resource', 'IP address', 'Change']} minWidth={900}>
            {query.data.items.map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap text-muted">{fmtDateTime(row.createdAt)}</td>
                <td>{row.actorEmail}</td>
                <td><Badge tone={/FAILED|DENIED|LOCKED/.test(row.action) ? 'bad' : /DELETE|DEACTIVAT|RESET/.test(row.action) ? 'warn' : 'neutral'}>{humanize(row.action)}</Badge></td>
                <td>{humanize(row.resource)} <span className="font-mono text-xs text-muted">{row.resourceId ?? ''}</span></td>
                <td className="font-mono text-xs text-muted">{row.ipAddress ?? '—'}</td>
                <td>{row.previousValue != null || row.newValue != null ? <button className="text-xs text-brand" onClick={() => setSelected(row)}>View change</button> : <span className="text-xs text-muted">—</span>}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={(page) => setFilters({ page: String(page) })} />
        </>
      ) : <EmptyState title="No audit entries match these filters." />}
      {selected ? (
        <Drawer title={humanize(selected.action)} onClose={() => setSelected(null)} wide>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div><dt className="text-muted">When</dt><dd>{fmtDateTime(selected.createdAt)}</dd></div>
            <div><dt className="text-muted">Actor</dt><dd>{selected.actorEmail}</dd></div>
            <div><dt className="text-muted">Resource</dt><dd>{humanize(selected.resource)} {selected.resourceId}</dd></div>
            <div><dt className="text-muted">IP address</dt><dd className="font-mono">{selected.ipAddress ?? '—'}</dd></div>
            <div className="col-span-2"><dt className="text-muted">User agent</dt><dd className="break-all">{selected.userAgent ?? '—'}</dd></div>
          </dl>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Previous value</p><pre className="max-h-96 overflow-auto rounded-xl bg-slate-50 p-3 text-xs dark:bg-white/5">{selected.previousValue == null ? '—' : JSON.stringify(selected.previousValue, null, 2)}</pre></div>
            <div><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">New value</p><pre className="max-h-96 overflow-auto rounded-xl bg-slate-50 p-3 text-xs dark:bg-white/5">{selected.newValue == null ? '—' : JSON.stringify(selected.newValue, null, 2)}</pre></div>
          </div>
        </Drawer>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------- Users */

const userSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(80),
  email: z.string().trim().email('Enter a valid email'),
  role: z.enum(ROLES),
})

export function UsersPage() {
  const { user: me } = useAuth()
  const toast = useToast()
  const client = useQueryClient()
  const [filters, setFilters] = useUrlFilters({ q: '', page: '1' })
  const [pending, setPending] = useState<PublicUser | null>(null)
  const [password, setPassword] = useState<{ email: string; value: string } | null>(null)
  const params = queryString({ q: filters.q, page: filters.page, limit: 25 })
  const query = useQuery({ queryKey: ['users', params], queryFn: () => api<{ items: PublicUser[]; page: number; totalPages: number }>(`/api/users?${params}`), placeholderData: (previous) => previous })
  const form = useForm<z.infer<typeof userSchema>>({ resolver: zodResolver(userSchema), defaultValues: { role: 'ANALYST' } })

  async function patch(target: PublicUser, body: Record<string, unknown>, success: string) {
    try {
      await api(`/api/users/${target.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      toast.push(success)
      client.invalidateQueries({ queryKey: ['users'] })
    } catch (error) { toast.push(errorMessage(error), 'err') }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Users" description="Demo accounts and roles. Role changes take effect on the user's next request and are audited." />
      <Card title="Create user">
        <form className="grid gap-3 md:grid-cols-4" onSubmit={form.handleSubmit(async (values) => {
          try {
            const result = await api<{ email: string; temporaryPassword?: string }>('/api/users', { method: 'POST', headers: idem('user'), body: JSON.stringify(values) })
            if (result.temporaryPassword) setPassword({ email: values.email, value: result.temporaryPassword })
            toast.push('User created')
            form.reset({ name: '', email: '', role: 'ANALYST' })
            client.invalidateQueries({ queryKey: ['users'] })
          } catch (error) { toast.push(errorMessage(error), 'err') }
        })}>
          <Field label="Name" error={form.formState.errors.name?.message}><input className={inputClass} {...form.register('name')} /></Field>
          <Field label="Email" error={form.formState.errors.email?.message}><input className={inputClass} type="email" {...form.register('email')} /></Field>
          <Field label="Role"><select className={inputClass} {...form.register('role')}>{ROLES.map((role) => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}</select></Field>
          <Button className="self-end" type="submit" disabled={form.formState.isSubmitting}>Create user</Button>
        </form>
      </Card>
      <input aria-label="Search users" className="rounded-full border border-line bg-card px-3 py-1.5 text-sm" placeholder="Name or email" value={filters.q} onChange={(event) => setFilters({ q: event.target.value })} />
      {query.isLoading ? <Skeleton className="h-48" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.items.length ? (
        <>
          <Table head={['Name', 'Email', 'Role', 'Status', 'Last login', 'Actions']} minWidth={860}>
            {query.data.items.map((user) => (
              <tr key={user.id}>
                <td>{user.name}{user.id === me?.id ? <span className="ml-1"><Badge tone="info">you</Badge></span> : null}</td>
                <td>{user.email}</td>
                <td>
                  <select aria-label={`Role for ${user.email}`} className="rounded-lg border border-line bg-card px-2 py-1 text-sm" value={user.role} disabled={user.id === me?.id} onChange={(event) => patch(user, { role: event.target.value as Role }, 'Role updated')}>
                    {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}
                  </select>
                </td>
                <td><StatusBadge status={user.status} /></td>
                <td className="text-muted">{user.lastLoginAt ? relTime(user.lastLoginAt) : 'Never'}</td>
                <td className="space-x-3 whitespace-nowrap text-xs">
                  <button className="text-brand" onClick={async () => {
                    try {
                      const result = await api<{ temporaryPassword: string }>(`/api/users/${user.id}/reset-password`, { method: 'POST', headers: idem(`reset-${user.id}`) })
                      setPassword({ email: user.email, value: result.temporaryPassword })
                    } catch (error) { toast.push(errorMessage(error), 'err') }
                  }}>Reset password</button>
                  {user.status === 'ACTIVE'
                    ? user.id !== me?.id ? <button className="text-red-700 dark:text-red-300" onClick={() => setPending(user)}>Deactivate</button> : null
                    : <button className="text-emerald-700 dark:text-emerald-300" onClick={() => patch(user, { status: 'ACTIVE' }, 'User reactivated')}>Reactivate</button>}
                </td>
              </tr>
            ))}
          </Table>
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={(page) => setFilters({ page: String(page) })} />
        </>
      ) : <EmptyState title="No users match." />}
      {pending ? <ConfirmDialog title="Deactivate user" body={`Deactivate ${pending.email}? They are signed out immediately. The last Super Admin cannot be deactivated.`} confirmLabel="Deactivate" danger onClose={() => setPending(null)} onConfirm={async () => { await patch(pending, { status: 'DEACTIVATED' }, 'User deactivated'); setPending(null) }} /> : null}
      {password ? <ConfirmDialog title="Temporary password" body={`Temporary password for ${password.email}: ${password.value} — share it securely. It is shown only once and must be changed at next sign-in.`} confirmLabel="Done" onClose={() => setPassword(null)} onConfirm={() => setPassword(null)} /> : null}
    </div>
  )
}

/* ------------------------------------------------------------ Notifications */

type NotificationRow = { id: string; type: string; title: string; message: string; severity: string; read: boolean; link: string | null; createdAt: string }

export function NotificationsPage() {
  const toast = useToast()
  const client = useQueryClient()
  const navigate = useNavigate()
  const [filters, setFilters] = useUrlFilters({ unread: '', page: '1' })
  const params = queryString({ unread: filters.unread, page: filters.page, limit: 25 })
  const query = useQuery({ queryKey: ['notifications', 'page', params], queryFn: () => api<{ items: NotificationRow[]; page: number; totalPages: number; total: number; unread: number }>(`/api/notifications?${params}`), placeholderData: (previous) => previous })

  async function markRead(row: NotificationRow) {
    if (!row.read) {
      await api(`/api/notifications/${row.id}/read`, { method: 'PATCH' }).catch(() => undefined)
      client.invalidateQueries({ queryKey: ['notifications'] })
    }
    if (row.link) navigate(row.link)
  }

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Alerts for incidents, anomalies, reports and security events, filtered by your notification preferences in Settings."
        actions={<Button variant="ghost" disabled={!query.data?.unread} onClick={async () => {
          try {
            await api('/api/notifications/read-all', { method: 'POST' })
            client.invalidateQueries({ queryKey: ['notifications'] })
            toast.push('All notifications marked read')
          } catch (error) { toast.push(errorMessage(error), 'err') }
        }}><CheckCheck className="mr-1 inline h-4 w-4" />Mark all read</Button>}
      />
      <div className="mb-3 flex items-center gap-2">
        <Select label="Show" value={filters.unread} onChange={(unread) => setFilters({ unread })} options={[['', 'All notifications'], ['true', 'Unread only']]} />
        {query.data ? <span className="text-xs text-muted">{query.data.unread} unread</span> : null}
      </div>
      {query.isLoading ? <Skeleton className="h-64" /> : query.isError ? <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} /> : query.data?.items.length ? (
        <>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card">
            {query.data.items.map((row) => (
              <li key={row.id}>
                <button className={`flex w-full items-start gap-3 p-4 text-left hover:bg-slate-50 dark:hover:bg-white/5 ${row.read ? '' : 'bg-blue-50/50 dark:bg-blue-950/20'}`} onClick={() => markRead(row)}>
                  <Bell className={`mt-0.5 h-4 w-4 shrink-0 ${row.read ? 'text-muted' : 'text-brand'}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2"><span className={row.read ? '' : 'font-semibold'}>{row.title}</span><StatusBadge status={row.severity} /><Badge>{humanize(row.type)}</Badge>{row.read ? null : <span className="sr-only">unread</span>}</span>
                    <span className="mt-0.5 block text-sm text-muted">{row.message}</span>
                    <span className="mt-1 block text-[11px] text-muted">{fmtDateTime(row.createdAt)} · {relTime(row.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <Pagination page={query.data.page} totalPages={query.data.totalPages} onPage={(page) => setFilters({ page: String(page) })} />
        </>
      ) : <EmptyState title={filters.unread ? 'No unread notifications.' : 'No notifications yet.'} />}
    </div>
  )
}

/* ----------------------------------------------------------------- Settings */

type Thresholds = { highValueAmount: number; failureRatePct: number; latencyMs: number; availabilityPct: number; volumeAnomalyPct: number; repeatedFailureCount: number; dedupWindowMinutes: number; rpmGate: number; consecutiveLatencyChecks: number }

export function SettingsPage() {
  const { user } = useAuth()
  const theme = useTheme()
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api<{ profile: PublicUser; thresholds: Thresholds | null; simulator: { tpm?: number; running?: boolean; scenarioLabel?: string | null; warning: string }; ai: { provider: string; message: string; model: string }; email: string; services: number }>('/api/settings') })
  const [tab, setTab] = useState('Profile')
  if (query.isLoading || !user) return <Skeleton className="h-48" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} message={errorMessage(query.error)} />
  const data = query.data!
  const tabs = ['Profile', 'Notifications', 'Security', 'Thresholds', 'Simulator', 'AI & email', 'Appearance']
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="mb-4 flex gap-2 overflow-auto" role="tablist">
        {tabs.map((item) => <button key={item} role="tab" aria-selected={tab === item} className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${tab === item ? 'bg-brand text-white' : 'border border-line'}`} onClick={() => setTab(item)}>{item}</button>)}
      </div>
      <Card>
        {tab === 'Profile' ? <ProfileForm /> : null}
        {tab === 'Notifications' ? <NotifyForm /> : null}
        {tab === 'Security' ? <PasswordForm /> : null}
        {tab === 'Thresholds' ? data.thresholds ? <ThresholdForm initial={data.thresholds} /> : <p className="text-sm text-muted">Only a Super Admin can view and change detection thresholds.</p> : null}
        {tab === 'Simulator' ? (
          <div className="space-y-2 text-sm">
            <p>{data.simulator.warning}</p>
            {data.simulator.tpm ? <p>Simulator is {data.simulator.running ? 'running' : 'stopped'} at {data.simulator.tpm} transactions per minute{data.simulator.scenarioLabel ? `, scenario: ${data.simulator.scenarioLabel}` : ''}.</p> : null}
            {can(user.role, 'simulator:control') ? <Link className="text-brand" to="/demo-simulator">Open the Demo Simulator →</Link> : <p className="text-muted">Only Super Admins and Engineers can control the simulator.</p>}
          </div>
        ) : null}
        {tab === 'AI & email' ? (
          <div className="space-y-2 text-sm">
            <p>AI provider: <strong>{data.ai.provider === 'mock' ? 'Local FinOpsX analysis engine' : `OpenAI-compatible (${data.ai.model})`}</strong></p>
            <p className="text-muted">{data.ai.message}</p>
            <p className="text-muted">Configure AI_PROVIDER, AI_API_KEY and AI_MODEL in the server environment. Keys are never entered or stored through this page.</p>
            <p>{data.email}</p>
          </div>
        ) : null}
        {tab === 'Appearance' ? (
          <div className="space-y-2 text-sm">
            <p>Theme is currently <strong>{theme.theme}</strong>; the choice is remembered in this browser.</p>
            <div className="flex gap-2">{(['light', 'dark', 'system'] as const).map((value) => <Button key={value} variant="ghost" onClick={() => theme.setTheme(value)}>{humanize(value)}</Button>)}</div>
          </div>
        ) : null}
      </Card>
    </div>
  )
}

function ProfileForm() {
  const { user, setUser } = useAuth()
  const toast = useToast()
  const [name, setName] = useState(user?.name ?? '')
  const [timezone, setTimezone] = useState(user?.timezone ?? 'Asia/Kathmandu')
  if (!user) return null
  return (
    <form className="grid max-w-lg gap-3" onSubmit={async (event) => {
      event.preventDefault()
      try {
        const next = await api<PublicUser>('/api/settings/profile', { method: 'PATCH', body: JSON.stringify({ name, timezone }) })
        setUser(next)
        toast.push('Profile saved')
      } catch (error) { toast.push(errorMessage(error), 'err') }
    }}>
      <p className="text-sm text-muted">{user.email} · {ROLE_LABEL[user.role]}</p>
      <Field label="Name"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required /></Field>
      <Field label="Timezone"><select className={inputClass} value={timezone} onChange={(event) => setTimezone(event.target.value)}>{['Asia/Kathmandu', 'UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York'].map((zone) => <option key={zone}>{zone}</option>)}</select></Field>
      <Button type="submit">Save profile</Button>
    </form>
  )
}

function NotifyForm() {
  const { user, setUser } = useAuth()
  const toast = useToast()
  if (!user) return null
  const keys = [['notifyIncidents', 'Incidents'], ['notifyAnomalies', 'Anomalies'], ['notifyReports', 'Reports'], ['notifySecurity', 'Security events']] as const
  return (
    <div className="grid gap-2 text-sm">
      {keys.map(([key, label]) => (
        <label key={key} className="flex items-center gap-2">
          <input type="checkbox" defaultChecked={user[key]} onChange={async (event) => {
            try {
              const next = await api<PublicUser>('/api/settings/profile', { method: 'PATCH', body: JSON.stringify({ [key]: event.target.checked }) })
              setUser(next)
              toast.push('Notification settings saved')
            } catch (error) { toast.push(errorMessage(error), 'err') }
          }} />
          {label}
        </label>
      ))}
    </div>
  )
}

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z.string().min(8, 'At least 8 characters').regex(/[a-z]/, 'Include a lowercase letter').regex(/[A-Z]/, 'Include an uppercase letter').regex(/\d/, 'Include a number'),
})

function PasswordForm() {
  const toast = useToast()
  const form = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema) })
  return (
    <form className="grid max-w-lg gap-3" onSubmit={form.handleSubmit(async (values) => {
      try {
        await api('/api/settings/profile', { method: 'PATCH', body: JSON.stringify(values) })
        toast.push('Password updated')
        form.reset()
      } catch (error) { toast.push(errorMessage(error), 'err') }
    })}>
      <Field label="Current password" error={form.formState.errors.currentPassword?.message}><input type="password" autoComplete="current-password" className={inputClass} {...form.register('currentPassword')} /></Field>
      <Field label="New password" error={form.formState.errors.newPassword?.message}><input type="password" autoComplete="new-password" className={inputClass} {...form.register('newPassword')} /></Field>
      <Button type="submit" disabled={form.formState.isSubmitting}>Update password</Button>
    </form>
  )
}

const THRESHOLD_FIELDS: Array<[keyof Thresholds, string, string]> = [
  ['highValueAmount', 'High-value transaction (NPR)', 'Payments at or above this amount raise a high-value anomaly.'],
  ['failureRatePct', 'Failure rate (%)', 'Minimum failure rate before a failure spike is considered.'],
  ['latencyMs', 'Latency (ms)', 'Average or P95 latency above this degrades a service.'],
  ['availabilityPct', 'API availability (%)', 'Availability below this degrades an endpoint.'],
  ['volumeAnomalyPct', 'Volume anomaly (% above normal)', 'How far volume must exceed the baseline.'],
  ['repeatedFailureCount', 'Repeated failures (count / 10 min)', 'Same reason at the same institution.'],
  ['dedupWindowMinutes', 'Incident de-duplication window (min)', 'Matching alerts inside this window update the open incident.'],
  ['rpmGate', 'Minimum requests per minute', 'Below this volume, rate-based rules are skipped to avoid noise.'],
  ['consecutiveLatencyChecks', 'Consecutive latency breaches', 'Checks in a row before a latency incident opens.'],
]

function ThresholdForm({ initial }: { initial: Thresholds }) {
  const toast = useToast()
  const client = useQueryClient()
  const [values, setValues] = useState(initial)
  const [busy, setBusy] = useState(false)
  return (
    <form className="grid gap-3 md:grid-cols-2" onSubmit={async (event) => {
      event.preventDefault()
      setBusy(true)
      try {
        await api('/api/settings/thresholds', { method: 'PATCH', body: JSON.stringify(values) })
        toast.push('Thresholds saved')
        client.invalidateQueries({ queryKey: ['settings'] })
      } catch (error) { toast.push(errorMessage(error), 'err') } finally { setBusy(false) }
    }}>
      {THRESHOLD_FIELDS.map(([key, label, hint]) => (
        <Field key={key} label={label}>
          <input className={inputClass} type="number" step="any" value={values[key]} onChange={(event) => setValues({ ...values, [key]: Number(event.target.value) })} />
          <span className="mt-1 block text-[11px] text-muted">{hint}</span>
        </Field>
      ))}
      <div className="md:col-span-2"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save thresholds'}</Button></div>
    </form>
  )
}

export function ProfilePage() {
  return (
    <div>
      <PageHeader title="Profile" />
      <Card><ProfileForm /><div className="mt-6 border-t border-line pt-6"><PasswordForm /></div></Card>
    </div>
  )
}
