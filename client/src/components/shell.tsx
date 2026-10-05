import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { io } from 'socket.io-client'
import { can, ROLE_LABEL, type Permission } from '@finopsx/shared'
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Bell,
  FileText,
  Landmark,
  LayoutDashboard,
  Menu,
  Moon,
  Radar,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  Sun,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { api, getAccessToken } from '../api'
import { useAuth, useTheme } from '../contexts'
import { Drawer, useDebounced } from './ui'

const LINKS: Array<{ to: string; label: string; permission: Permission; icon: LucideIcon }> = [
  { to: '/dashboard', label: 'Dashboard', permission: 'dashboard:view', icon: LayoutDashboard },
  { to: '/transactions', label: 'Transactions', permission: 'transactions:view', icon: ArrowLeftRight },
  { to: '/system-health', label: 'System health', permission: 'system:view', icon: Activity },
  { to: '/incidents', label: 'Incidents', permission: 'incidents:view', icon: AlertTriangle },
  { to: '/institutions', label: 'Institutions', permission: 'institutions:view', icon: Landmark },
  { to: '/anomalies', label: 'Anomalies', permission: 'anomalies:view', icon: Radar },
  { to: '/analytics', label: 'Analytics', permission: 'analytics:view', icon: BarChart3 },
  { to: '/reports', label: 'Reports', permission: 'reports:view', icon: FileText },
  { to: '/ai-assistant', label: 'AI assistant', permission: 'ai:use', icon: Sparkles },
  { to: '/audit-logs', label: 'Audit logs', permission: 'audit:view', icon: ScrollText },
  { to: '/users', label: 'Users', permission: 'users:manage', icon: Users },
  { to: '/settings', label: 'Settings', permission: 'dashboard:view', icon: Settings },
]

export function AppShell() {
  const { user, logout } = useAuth()
  const theme = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const [notes, setNotes] = useState(false)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const debounced = useDebounced(search, 300)
  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ unread: number; items: Array<{ id: string; title: string; message: string; read: boolean; link?: string; severity: string }> }>('/api/notifications'),
  })
  const results = useQuery({
    queryKey: ['search', debounced],
    enabled: debounced.trim().length >= 2,
    queryFn: () => api<Record<string, Array<{ id: string; link: string; title?: string; name?: string; status?: string; amount?: number }>>>(`/api/search?q=${encodeURIComponent(debounced)}`),
  })

  useEffect(() => {
    const token = getAccessToken()
    if (!token) return
    const socket = io(import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || undefined, { auth: { token }, transports: ['websocket', 'polling'] })
    let timer: number | undefined
    const refresh = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['dashboard'] })
        queryClient.invalidateQueries({ queryKey: ['transactions'] })
        queryClient.invalidateQueries({ queryKey: ['notifications'] })
        queryClient.invalidateQueries({ queryKey: ['incidents'] })
        queryClient.invalidateQueries({ queryKey: ['anomalies'] })
        queryClient.invalidateQueries({ queryKey: ['health'] })
      }, 700)
    }
    ;['transaction:new', 'transaction:updated', 'incident:created', 'incident:updated', 'incident:resolved', 'system:status', 'anomaly:detected', 'notification:created'].forEach((event) => socket.on(event, refresh))
    return () => { socket.close(); window.clearTimeout(timer) }
  }, [queryClient, user?.id])

  if (!user) return null
  const links = LINKS.filter((link) => can(user.role, link.permission))
  const initials = user.name.split(' ').map((part) => part[0]).slice(0, 2).join('')

  const labeledNav = (
    <nav className="flex flex-1 flex-col gap-1" aria-label="Primary">
      {links.map((link) => {
        const Icon = link.icon
        return (
          <NavLink key={link.to} to={link.to} onClick={() => setOpen(false)} className={({ isActive }) => `flex items-center gap-3 rounded-2xl px-3 py-2 text-sm ${isActive ? 'bg-[#e8f0ff] text-brand' : 'text-muted hover:bg-[#f4f6fa] dark:hover:bg-white/5'}`}>
            <Icon size={18} /> {link.label}
          </NavLink>
        )
      })}
    </nav>
  )

  return (
    <div className="min-h-screen bg-canvas p-3 text-ink md:p-4">
      <div className="mx-auto flex min-h-[calc(100vh-1.5rem)] max-w-[1600px] gap-3 md:min-h-[calc(100vh-2rem)]">
        <aside className="hidden w-[76px] shrink-0 flex-col items-center rounded-[28px] bg-card py-4 shadow-card md:flex">
          <div className="mb-6 grid h-10 w-10 place-items-center text-[15px] font-black tracking-tight">FX</div>
          <nav className="flex w-full flex-1 flex-col items-center gap-1.5" aria-label="Primary">
            {links.map((link) => {
              const Icon = link.icon
              return (
                <NavLink key={link.to} to={link.to} title={link.label} aria-label={link.label} className={({ isActive }) => `grid h-10 w-10 place-items-center rounded-2xl ${isActive ? 'bg-[#e8f0ff] text-brand' : 'text-[#98a2b3] hover:bg-[#f4f6fa] dark:hover:bg-white/5'}`}>
                  <Icon size={18} />
                </NavLink>
              )
            })}
          </nav>
          <div className="relative mt-4">
            <button className="grid h-10 w-10 place-items-center rounded-full bg-[#1b2437] text-xs font-semibold text-white" aria-label={`${user.name}, ${ROLE_LABEL[user.role]}`} aria-haspopup="menu" onClick={() => setMenu((value) => !value)}>{initials}</button>
            {menu ? (
              <div className="absolute bottom-0 left-12 z-30 w-40 rounded-2xl border border-line bg-card p-1 text-sm shadow-card" role="menu">
                <p className="px-2 py-1 text-xs text-muted">{user.name}</p>
                <button className="block w-full rounded-xl px-2 py-1.5 text-left" onClick={() => { setMenu(false); navigate('/profile') }}>Profile</button>
                <button className="block w-full rounded-xl px-2 py-1.5 text-left" onClick={() => { setMenu(false); logout().then(() => navigate('/login')) }}>Log out</button>
              </div>
            ) : null}
          </div>
        </aside>
        {open ? <Drawer title="FinOpsX" onClose={() => setOpen(false)}>{labeledNav}</Drawer> : null}
        <div className="relative flex min-w-0 flex-1 flex-col rounded-[28px] bg-card shadow-card">
          <div className="absolute right-4 top-4 z-20 flex items-center gap-1.5 md:right-6 md:top-5">
            <button className="grid h-10 w-10 place-items-center rounded-full text-[#667085] md:hidden" aria-label="Open navigation" onClick={() => setOpen(true)}><Menu size={18} /></button>
            {location.pathname === '/dashboard' ? <Link to="/transactions" className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-white">View all</Link> : null}
            <div className="relative">
              <button className="grid h-10 w-10 place-items-center rounded-full text-[#667085] hover:bg-[#f4f6fa] dark:hover:bg-white/5" aria-label="Search transactions, incidents, institutions" onClick={() => setSearchOpen((value) => !value)}>
                <Search size={18} />
              </button>
              {searchOpen ? (
                <div className="absolute right-0 z-30 mt-2 w-80 rounded-2xl border border-line bg-card p-2 text-sm shadow-card">
                  <input autoFocus aria-label="Search transactions, incidents, institutions" className="w-full rounded-xl bg-[#f4f6fa] px-3 py-2 outline-none dark:bg-white/5" placeholder="Search transactions, incidents, institutions..." value={search} onChange={(event) => setSearch(event.target.value)} />
                  {debounced.trim().length >= 2 ? (
                    <div className="mt-2 max-h-80 overflow-auto">
                      {results.isLoading ? <p className="p-2 text-muted">Searching…</p> : null}
                      {results.data && Object.entries(results.data).map(([group, items]) => items.length ? (
                        <div key={group} className="mb-2">
                          <p className="px-2 text-[11px] uppercase tracking-wide text-muted">{group}</p>
                          {items.map((item) => (
                            <button key={item.id} className="block w-full rounded-xl px-2 py-1.5 text-left hover:bg-[#f4f6fa] dark:hover:bg-white/5" onClick={() => { setSearchOpen(false); navigate(item.link) }}>
                              <span className="font-medium">{item.title ?? item.name ?? item.id}</span>
                              {item.status ? <span className="ml-2 text-xs text-muted">{item.status}</span> : null}
                            </button>
                          ))}
                        </div>
                      ) : null)}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <button className="relative grid h-10 w-10 place-items-center rounded-full text-[#667085] hover:bg-[#f4f6fa] dark:hover:bg-white/5" aria-label="Notifications" onClick={() => setNotes((value) => !value)}>
              <Bell size={18} />
              {notifications.data?.unread ? <span className="absolute right-1 top-1 rounded-full bg-red-600 px-1 text-[10px] text-white">{notifications.data.unread}</span> : null}
            </button>
            {notes ? (
              <div className="absolute right-0 top-12 z-30 w-80 rounded-2xl border border-line bg-card p-2 text-sm shadow-card">
                <div className="mb-2 flex justify-between px-1"><span className="font-medium">Notifications</span><button className="text-xs text-brand" onClick={async () => { await api('/api/notifications/read-all', { method: 'POST' }); notifications.refetch() }}>Mark all as read</button></div>
                {notifications.data?.items.length ? notifications.data.items.map((item) => (
                  <button key={item.id} className={`mb-1 block w-full rounded-xl px-2 py-2 text-left hover:bg-[#f4f6fa] dark:hover:bg-white/5 ${item.read ? 'opacity-60' : ''}`} onClick={async () => { await api(`/api/notifications/${item.id}/read`, { method: 'PATCH' }); setNotes(false); if (item.link) navigate(item.link); notifications.refetch() }}>
                    <span className="font-medium">{item.title}</span>
                    <span className="block text-xs text-muted">{item.message}</span>
                  </button>
                )) : <p className="p-2 text-muted">No notifications.</p>}
              </div>
            ) : null}
            <button className="grid h-10 w-10 place-items-center rounded-full text-[#667085] hover:bg-[#f4f6fa] dark:hover:bg-white/5" aria-label="Toggle color theme" onClick={theme.toggle}>{theme.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
            <div className="relative">
              <button className="grid h-10 w-10 place-items-center rounded-full bg-[#1b2437] text-xs font-semibold text-white md:hidden" aria-haspopup="menu" aria-label={user.name} onClick={() => setMenu((value) => !value)}>{initials}</button>
              {menu ? (
                <div className="absolute right-0 z-30 mt-2 w-40 rounded-2xl border border-line bg-card p-1 text-sm shadow-card" role="menu">
                  <button className="block w-full rounded-xl px-2 py-1.5 text-left" onClick={() => { setMenu(false); navigate('/profile') }}>Profile</button>
                  <button className="block w-full rounded-xl px-2 py-1.5 text-left" onClick={() => { setMenu(false); logout().then(() => navigate('/login')) }}>Log out</button>
                </div>
              ) : null}
            </div>
          </div>
          <main className={`min-w-0 flex-1 px-4 pb-4 md:px-6 md:pb-5 ${location.pathname === '/dashboard' ? 'pt-[4.5rem] md:pt-5' : 'pt-[4.5rem] md:pt-20'}`}><Outlet /></main>
          <footer className="px-6 pb-5 text-xs text-muted">Conceptual fintech operations platform using synthetic demonstration data. Times shown in {user.timezone}.</footer>
        </div>
      </div>
    </div>
  )
}
