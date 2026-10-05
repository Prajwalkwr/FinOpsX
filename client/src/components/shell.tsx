import { useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { can, DEMO_LABELS, ROLE_LABEL, type Permission } from '@finopsx/shared'
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Bell,
  CalendarClock,
  DatabaseZap,
  FileText,
  FlaskConical,
  Landmark,
  LayoutDashboard,
  Menu,
  Moon,
  Network,
  Radar,
  Scale,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  Sun,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { api } from '../api'
import { useAuth, useTheme, useToast } from '../contexts'
import { LiveIndicator, useRealtimeEvent } from '../realtime'
import { relTime } from '../lib/format'
import { Drawer, useDebounced } from './ui'

type NavItem = { to: string; label: string; permission: Permission; icon: LucideIcon }

export const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Overview', permission: 'dashboard:view', icon: LayoutDashboard },
  { to: '/transactions', label: 'Transactions', permission: 'transactions:view', icon: ArrowLeftRight },
  { to: '/system-health', label: 'System Health', permission: 'system:view', icon: Activity },
  { to: '/incidents', label: 'Incidents', permission: 'incidents:view', icon: AlertTriangle },
  { to: '/institutions', label: 'Institutions', permission: 'institutions:view', icon: Landmark },
  { to: '/anomalies', label: 'Anomalies', permission: 'anomalies:view', icon: Radar },
  { to: '/analytics', label: 'Analytics', permission: 'analytics:view', icon: BarChart3 },
  { to: '/ai-assistant', label: 'AI Assistant', permission: 'ai:use', icon: Sparkles },
  { to: '/reports', label: 'Reports', permission: 'reports:view', icon: FileText },
  { to: '/notifications', label: 'Notifications', permission: 'notifications:view', icon: Bell },
  { to: '/audit-logs', label: 'Audit Logs', permission: 'audit:view', icon: ScrollText },
  { to: '/users', label: 'Users', permission: 'users:manage', icon: Users },
  { to: '/jobs', label: 'Operational Jobs', permission: 'jobs:view', icon: CalendarClock },
  { to: '/reconciliation', label: 'Reconciliation', permission: 'reconciliation:view', icon: Scale },
  { to: '/data-quality', label: 'Data Quality', permission: 'dataquality:view', icon: DatabaseZap },
  { to: '/service-map', label: 'Service Map', permission: 'services:view', icon: Network },
  { to: '/demo-simulator', label: 'Demo Simulator', permission: 'simulator:control', icon: FlaskConical },
  { to: '/settings', label: 'Settings', permission: 'dashboard:view', icon: Settings },
]

type NotificationPage = { unread: number; items: Array<{ id: string; title: string; message: string; read: boolean; link?: string | null; severity: string; createdAt: string }> }

export function AppShell() {
  const { user, logout } = useAuth()
  const theme = useTheme()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const [notes, setNotes] = useState(false)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const debounced = useDebounced(search, 300)
  const notifications = useQuery({ queryKey: ['notifications', 'menu'], queryFn: () => api<NotificationPage>('/api/notifications?limit=8') })
  const results = useQuery({
    queryKey: ['search', debounced],
    enabled: debounced.trim().length >= 2,
    queryFn: () => api<Record<string, Array<{ id: string; link: string; title?: string; name?: string; status?: string }>>>(`/api/search?q=${encodeURIComponent(debounced)}`),
  })

  useRealtimeEvent<{ title: string; severity: string; link?: string }>('notification:created', (payload) => {
    if (payload.severity === 'CRITICAL' || payload.severity === 'HIGH') toast.push(payload.title, 'err')
  })

  if (!user) return null
  const links = NAV.filter((link) => can(user.role, link.permission))
  const initials = user.name.split(' ').map((part) => part[0]).slice(0, 2).join('')

  const labeledNav = (
    <nav className="flex flex-1 flex-col gap-1" aria-label="Primary">
      {links.map((link) => {
        const Icon = link.icon
        return (
          <NavLink key={link.to} to={link.to} onClick={() => setOpen(false)} className={({ isActive }) => `flex items-center gap-3 rounded-2xl px-3 py-2 text-sm ${isActive ? 'bg-[#e8f0ff] text-brand dark:bg-white/10' : 'text-muted hover:bg-[#f4f6fa] dark:hover:bg-white/5'}`}>
            <Icon size={18} aria-hidden="true" /> {link.label}
          </NavLink>
        )
      })}
    </nav>
  )

  return (
    <div className="min-h-screen bg-canvas p-3 text-ink md:p-4">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[90] focus:rounded-full focus:bg-brand focus:px-4 focus:py-2 focus:text-white">Skip to content</a>
      <div className="mx-auto flex min-h-[calc(100vh-1.5rem)] max-w-[1600px] gap-3 md:min-h-[calc(100vh-2rem)]">
        <aside className="sticky top-4 hidden max-h-[calc(100vh-2rem)] w-[76px] shrink-0 flex-col items-center rounded-[28px] bg-card py-4 shadow-card md:flex">
          <Link to="/dashboard" className="mb-4 grid h-10 w-10 place-items-center text-[15px] font-black tracking-tight" aria-label="FinOpsX overview">FX</Link>
          <nav className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-2" aria-label="Primary">
            {links.map((link) => {
              const Icon = link.icon
              return (
                <NavLink key={link.to} to={link.to} title={link.label} aria-label={link.label} className={({ isActive }) => `grid h-10 w-10 shrink-0 place-items-center rounded-2xl ${isActive ? 'bg-[#e8f0ff] text-brand dark:bg-white/10' : 'text-[#98a2b3] hover:bg-[#f4f6fa] dark:hover:bg-white/5'}`}>
                  <Icon size={18} aria-hidden="true" />
                </NavLink>
              )
            })}
          </nav>
          <div className="relative mt-3">
            <button className="grid h-10 w-10 place-items-center rounded-full bg-[#1b2437] text-xs font-semibold text-white" aria-label={`${user.name}, ${ROLE_LABEL[user.role]}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((value) => !value)}>{initials}</button>
            {menu ? (
              <div className="absolute bottom-0 left-12 z-30 w-44 rounded-2xl border border-line bg-card p-1 text-sm shadow-card" role="menu">
                <p className="px-2 py-1 text-xs text-muted">{user.name} · {ROLE_LABEL[user.role]}</p>
                <button role="menuitem" className="block w-full rounded-xl px-2 py-1.5 text-left hover:bg-[#f4f6fa] dark:hover:bg-white/5" onClick={() => { setMenu(false); navigate('/profile') }}>Profile</button>
                <button role="menuitem" className="block w-full rounded-xl px-2 py-1.5 text-left hover:bg-[#f4f6fa] dark:hover:bg-white/5" onClick={() => { setMenu(false); logout().then(() => navigate('/login')) }}>Log out</button>
              </div>
            ) : null}
          </div>
        </aside>
        {open ? <Drawer title="FinOpsX" onClose={() => setOpen(false)}>{labeledNav}</Drawer> : null}
        <div className="relative flex min-w-0 flex-1 flex-col rounded-[28px] bg-card shadow-card">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 md:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <button className="grid h-10 w-10 place-items-center rounded-full text-[#667085] md:hidden" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)}><Menu size={18} /></button>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{DEMO_LABELS.environment}</p>
                <p className="truncate text-[11px] text-muted"><span className="mr-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">{DEMO_LABELS.synthetic}</span><span className="hidden sm:inline">{DEMO_LABELS.disclaimer}</span></p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <LiveIndicator />
              <div className="relative">
                <button className="grid h-10 w-10 place-items-center rounded-full text-[#667085] hover:bg-[#f4f6fa] dark:hover:bg-white/5" aria-label="Search transactions, incidents, institutions" aria-expanded={searchOpen} onClick={() => setSearchOpen((value) => !value)}>
                  <Search size={18} />
                </button>
                {searchOpen ? (
                  <div className="absolute right-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-line bg-card p-2 text-sm shadow-card">
                    <input autoFocus aria-label="Search transactions, incidents, institutions" className="w-full rounded-xl bg-[#f4f6fa] px-3 py-2 outline-none dark:bg-white/5" placeholder="Transaction ID, INC-, ANM-, bank…" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setSearchOpen(false) }} />
                    {debounced.trim().length >= 2 ? (
                      <div className="mt-2 max-h-80 overflow-auto">
                        {results.isLoading ? <p className="p-2 text-muted">Searching…</p> : null}
                        {results.data && Object.values(results.data).every((items) => !items.length) ? <p className="p-2 text-muted">No matches.</p> : null}
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
              <div className="relative">
                <button className="relative grid h-10 w-10 place-items-center rounded-full text-[#667085] hover:bg-[#f4f6fa] dark:hover:bg-white/5" aria-label={`Notifications${notifications.data?.unread ? `, ${notifications.data.unread} unread` : ''}`} aria-expanded={notes} onClick={() => setNotes((value) => !value)}>
                  <Bell size={18} />
                  {notifications.data?.unread ? <span className="absolute right-1 top-1 rounded-full bg-red-600 px-1 text-[10px] text-white">{notifications.data.unread > 99 ? '99+' : notifications.data.unread}</span> : null}
                </button>
                {notes ? (
                  <div className="absolute right-0 top-12 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-line bg-card p-2 text-sm shadow-card">
                    <div className="mb-2 flex justify-between px-1"><span className="font-medium">Notifications</span><button className="text-xs text-brand" onClick={async () => { await api('/api/notifications/read-all', { method: 'POST' }); notifications.refetch() }}>Mark all as read</button></div>
                    {notifications.data?.items.length ? notifications.data.items.map((item) => (
                      <button key={item.id} className={`mb-1 block w-full rounded-xl px-2 py-2 text-left hover:bg-[#f4f6fa] dark:hover:bg-white/5 ${item.read ? 'opacity-60' : ''}`} onClick={async () => { await api(`/api/notifications/${item.id}/read`, { method: 'PATCH' }); setNotes(false); if (item.link) navigate(item.link); notifications.refetch() }}>
                        <span className="font-medium">{item.title}</span>
                        <span className="block text-xs text-muted">{item.message}</span>
                        <span className="block text-[11px] text-muted">{relTime(item.createdAt)}</span>
                      </button>
                    )) : <p className="p-2 text-muted">No notifications.</p>}
                    <Link to="/notifications" className="mt-1 block rounded-xl px-2 py-1.5 text-center text-xs text-brand hover:bg-[#f4f6fa] dark:hover:bg-white/5" onClick={() => setNotes(false)}>View all notifications</Link>
                  </div>
                ) : null}
              </div>
              <button className="grid h-10 w-10 place-items-center rounded-full text-[#667085] hover:bg-[#f4f6fa] dark:hover:bg-white/5" aria-label="Toggle color theme" onClick={theme.toggle}>{theme.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
              <div className="relative md:hidden">
                <button className="grid h-10 w-10 place-items-center rounded-full bg-[#1b2437] text-xs font-semibold text-white" aria-haspopup="menu" aria-expanded={menu} aria-label={user.name} onClick={() => setMenu((value) => !value)}>{initials}</button>
                {menu ? (
                  <div className="absolute right-0 z-30 mt-2 w-40 rounded-2xl border border-line bg-card p-1 text-sm shadow-card" role="menu">
                    <button role="menuitem" className="block w-full rounded-xl px-2 py-1.5 text-left" onClick={() => { setMenu(false); navigate('/profile') }}>Profile</button>
                    <button role="menuitem" className="block w-full rounded-xl px-2 py-1.5 text-left" onClick={() => { setMenu(false); logout().then(() => navigate('/login')) }}>Log out</button>
                  </div>
                ) : null}
              </div>
            </div>
          </header>
          <main id="main" key={location.pathname.split('/')[1]} className="min-w-0 flex-1 px-4 pb-4 pt-5 md:px-6 md:pb-5">
            <Outlet />
          </main>
          <footer className="border-t border-line px-6 py-4 text-xs text-muted">
            {DEMO_LABELS.environment} · {DEMO_LABELS.synthetic}. {DEMO_LABELS.disclaimer} Times shown in {user.timezone}.
          </footer>
        </div>
      </div>
    </div>
  )
}
