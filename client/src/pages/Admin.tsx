import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ROLE_LABEL, ROLES, type PublicUser, type Role } from '@finopsx/shared'
import { api } from '../api'
import { useAuth, useTheme, useToast } from '../contexts'
import { Button, ConfirmDialog, ErrorState, Field, inputClass, Pagination, Skeleton } from '../components/ui'

export function AuditPage() {
  const [page, setPage] = useState(1)
  const query = useQuery({ queryKey: ['audit', page], queryFn: () => api<{ items: Array<{ id: string; actorEmail: string; action: string; resource: string; resourceId: string | null; createdAt: string; ipAddress: string | null; previousValue: unknown; newValue: unknown }>; page: number; totalPages: number }>(`/api/audit-logs?page=${page}&limit=25`) })
  if (query.isLoading) return <Skeleton className="h-64" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Audit logs</h1>
      <div className="table-wrap rounded-lg border border-line bg-card"><table className="w-full min-w-[860px] text-left text-sm"><thead className="text-xs text-muted"><tr><th className="p-2">When</th><th>User</th><th>Action</th><th>Resource</th><th>Previous</th><th>New</th></tr></thead><tbody>{query.data?.items.map((row) => <tr key={row.id} className="border-t border-line align-top"><td className="p-2">{new Date(row.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu', hour12: false })}</td><td>{row.actorEmail}</td><td>{row.action}</td><td>{row.resource} {row.resourceId ?? ''}</td><td className="max-w-[12rem] truncate">{JSON.stringify(row.previousValue ?? '')}</td><td className="max-w-[12rem] truncate">{JSON.stringify(row.newValue ?? '')}</td></tr>)}</tbody></table></div>
      <Pagination page={query.data?.page ?? 1} totalPages={query.data?.totalPages ?? 1} onPage={setPage} />
    </div>
  )
}

const userSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  role: z.enum(ROLES),
})

export function UsersPage() {
  const toast = useToast()
  const client = useQueryClient()
  const [page, setPage] = useState(1)
  const [pending, setPending] = useState<PublicUser | null>(null)
  const query = useQuery({ queryKey: ['users', page], queryFn: () => api<{ items: PublicUser[]; page: number; totalPages: number }>(`/api/users?page=${page}&limit=25`) })
  const form = useForm<z.infer<typeof userSchema>>({ resolver: zodResolver(userSchema), defaultValues: { role: 'ANALYST' } })
  if (query.isLoading) return <Skeleton className="h-48" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Users</h1>
      <form className="grid gap-3 rounded-lg border border-line bg-card p-4 md:grid-cols-4" onSubmit={form.handleSubmit(async (values) => {
        const result = await api<{ temporaryPassword?: string }>('/api/users', { method: 'POST', headers: { 'Idempotency-Key': `user-${values.email}` }, body: JSON.stringify(values) })
        toast.push(result.temporaryPassword ? `User created. Temporary password ${result.temporaryPassword}` : 'User created')
        form.reset()
        client.invalidateQueries({ queryKey: ['users'] })
      })}>
        <Field label="Name" error={form.formState.errors.name?.message}><input className={inputClass} {...form.register('name')} /></Field>
        <Field label="Email" error={form.formState.errors.email?.message}><input className={inputClass} {...form.register('email')} /></Field>
        <Field label="Role"><select className={inputClass} {...form.register('role')}>{ROLES.map((role) => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}</select></Field>
        <Button className="self-end" type="submit" disabled={form.formState.isSubmitting}>Create user</Button>
      </form>
      <div className="table-wrap rounded-lg border border-line bg-card"><table className="w-full text-left text-sm"><thead className="text-xs text-muted"><tr><th className="p-2">Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>{query.data?.items.map((user) => <tr key={user.id} className="border-t border-line"><td className="p-2">{user.name}</td><td>{user.email}</td><td><select aria-label={`Role for ${user.email}`} className="bg-transparent" value={user.role} onChange={async (event) => { await api(`/api/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role: event.target.value as Role }) }); toast.push('Role updated'); query.refetch() }}>{ROLES.map((role) => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}</select></td><td>{user.status}</td><td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('en-GB', { timeZone: 'Asia/Kathmandu' }) : '—'}</td><td className="space-x-2"><button className="text-blue-700" onClick={async () => { const result = await api<{ temporaryPassword: string }>(`/api/users/${user.id}/reset-password`, { method: 'POST', headers: { 'Idempotency-Key': `reset-${user.id}-${Date.now()}` } }); toast.push(`Temporary password ${result.temporaryPassword}`) }}>Reset password</button><button className="text-red-700" onClick={() => setPending(user)}>Deactivate</button></td></tr>)}</tbody></table></div>
      <Pagination page={query.data?.page ?? 1} totalPages={query.data?.totalPages ?? 1} onPage={setPage} />
      {pending ? <ConfirmDialog title="Deactivate user" body={`Deactivate ${pending.email}? The final Super Admin cannot be removed.`} confirmLabel="Deactivate" danger onClose={() => setPending(null)} onConfirm={async () => { try { await api(`/api/users/${pending.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'DEACTIVATED' }) }); toast.push('User deactivated'); query.refetch() } catch (error) { toast.push((error as { message: string }).message, 'err') } setPending(null) }} /> : null}
    </div>
  )
}

export function SettingsPage() {
  const { user } = useAuth()
  const toast = useToast()
  const theme = useTheme()
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api<{ profile: PublicUser; thresholds: { highValueAmount: number; failureRatePct: number; latencyMs: number; availabilityPct: number; volumeAnomalyPct: number; repeatedFailureCount: number } | null; simulator: { tpm?: number; warning: string }; ai: { provider: string; message: string }; email: string }>('/api/settings') })
  const [tab, setTab] = useState('Profile')
  if (query.isLoading || !user) return <Skeleton className="h-48" />
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />
  const tabs = ['Profile', 'Notifications', 'Security', 'Thresholds', 'Simulator', 'AI', 'Preferences']
  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Settings</h1>
      <div className="mb-4 flex gap-2 overflow-auto">{tabs.map((item) => <button key={item} className={`rounded-full px-3 py-1 text-sm ${tab === item ? 'bg-brand text-white' : 'border border-line'}`} onClick={() => setTab(item)}>{item}</button>)}</div>
      {tab === 'Profile' || tab === 'Preferences' ? <ProfileForm /> : null}
      {tab === 'Notifications' ? <NotifyForm /> : null}
      {tab === 'Security' ? <PasswordForm /> : null}
      {tab === 'Thresholds' ? query.data?.thresholds ? <ThresholdForm initial={query.data.thresholds} /> : <p className="text-sm">Only a super admin can change thresholds.</p> : null}
      {tab === 'Simulator' ? <p className="text-sm">{query.data?.simulator.warning} {query.data?.simulator.tpm ? `Current rate ${query.data.simulator.tpm} transactions/minute.` : ''} Use the dashboard demo controls if your role allows it.</p> : null}
      {tab === 'AI' ? <div className="text-sm"><p>Provider: {query.data?.ai.provider}</p><p className="mt-2">{query.data?.ai.message}</p><p className="mt-2 text-muted">Set AI_PROVIDER and AI_API_KEY in the server environment. The key is never stored from this page.</p><p className="mt-2">{query.data?.email}</p><button className="mt-3 text-blue-700" onClick={() => theme.setTheme(theme.theme === 'dark' ? 'light' : 'dark')}>Theme is {theme.theme}. Toggle and it is remembered on this browser.</button></div> : null}
    </div>
  )
}

function ProfileForm() {
  const { user, setUser } = useAuth()
  const toast = useToast()
  const [name, setName] = useState(user?.name ?? '')
  const [timezone, setTimezone] = useState(user?.timezone ?? 'Asia/Kathmandu')
  if (!user) return null
  return <form className="grid max-w-lg gap-3" onSubmit={async (event) => { event.preventDefault(); const next = await api<PublicUser>('/api/settings/profile', { method: 'PATCH', body: JSON.stringify({ name, timezone }) }); setUser(next); toast.push('Profile saved') }}><Field label="Name"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Timezone"><input className={inputClass} value={timezone} onChange={(event) => setTimezone(event.target.value)} /></Field><Button type="submit">Save profile</Button></form>
}

function NotifyForm() {
  const { user, setUser } = useAuth()
  const toast = useToast()
  if (!user) return null
  const keys = [['notifyIncidents', 'Incidents'], ['notifyAnomalies', 'Anomalies'], ['notifyReports', 'Reports'], ['notifySecurity', 'Security']] as const
  return <div className="grid gap-2 text-sm">{keys.map(([key, label]) => <label key={key}><input type="checkbox" className="mr-2" defaultChecked={user[key]} onChange={async (event) => { const next = await api<PublicUser>('/api/settings/profile', { method: 'PATCH', body: JSON.stringify({ [key]: event.target.checked }) }); setUser(next); toast.push('Notification settings saved') }} />{label}</label>)}</div>
}

function PasswordForm() {
  const toast = useToast()
  const form = useForm<{ currentPassword: string; newPassword: string }>({ resolver: zodResolver(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).regex(/[a-z]/).regex(/[A-Z]/).regex(/\d/) })) })
  return <form className="grid max-w-lg gap-3" onSubmit={form.handleSubmit(async (values) => { try { await api('/api/settings/profile', { method: 'PATCH', body: JSON.stringify(values) }); toast.push('Password updated'); form.reset() } catch (error) { toast.push((error as { message: string }).message, 'err') } })}><Field label="Current password" error={form.formState.errors.currentPassword?.message}><input type="password" className={inputClass} {...form.register('currentPassword')} /></Field><Field label="New password" error={form.formState.errors.newPassword?.message}><input type="password" className={inputClass} {...form.register('newPassword')} /></Field><Button type="submit" disabled={form.formState.isSubmitting}>Update password</Button></form>
}

function ThresholdForm({ initial }: { initial: { highValueAmount: number; failureRatePct: number; latencyMs: number; availabilityPct: number; volumeAnomalyPct: number; repeatedFailureCount: number } }) {
  const toast = useToast()
  const [values, setValues] = useState(initial)
  const fields = [
    ['highValueAmount', 'High value (Rs.)'],
    ['failureRatePct', 'Failure rate %'],
    ['latencyMs', 'Latency ms'],
    ['availabilityPct', 'Availability %'],
    ['volumeAnomalyPct', 'Volume anomaly %'],
    ['repeatedFailureCount', 'Repeated failures'],
  ] as const
  return <form className="grid max-w-lg gap-3" onSubmit={async (event) => { event.preventDefault(); await api('/api/settings/thresholds', { method: 'PATCH', body: JSON.stringify(values) }); toast.push('Thresholds saved') }}>{fields.map(([key, label]) => <Field key={key} label={label}><input className={inputClass} type="number" value={values[key]} onChange={(event) => setValues({ ...values, [key]: Number(event.target.value) })} /></Field>)}<Button type="submit">Save thresholds</Button></form>
}

export function ProfilePage() {
  return <div><h1 className="mb-4 text-xl font-semibold">Profile</h1><ProfileForm /><div className="mt-6"><PasswordForm /></div></div>
}
