import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PublicUser } from '@finopsx/shared'
import { api, clearSession, refreshTokenValue, setSession } from './api'

type AuthContextValue = {
  user: PublicUser | null
  loading: boolean
  login: (payload: { accessToken: string; refreshToken: string; user: PublicUser }, remember: boolean) => void
  logout: () => Promise<void>
  setUser: (user: PublicUser) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)
const ThemeContext = createContext<{ theme: 'light' | 'dark'; toggle: () => void; setTheme: (value: 'light' | 'dark' | 'system') => void } | null>(null)
const ToastContext = createContext<{ push: (message: string, tone?: 'ok' | 'err') => void } | null>(null)

function resolveTheme(pref: 'light' | 'dark' | 'system') {
  if (pref === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  return pref
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [pref, setPref] = useState<'light' | 'dark' | 'system'>(() => (localStorage.getItem('finopsx.theme') as 'light' | 'dark' | 'system') || 'system')
  const [theme, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(pref))
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; tone: 'ok' | 'err' }>>([])

  useEffect(() => {
    const next = resolveTheme(pref)
    setResolved(next)
    document.documentElement.classList.toggle('dark', next === 'dark')
    localStorage.setItem('finopsx.theme', pref)
  }, [pref])

  useEffect(() => {
    if (!refreshTokenValue()) {
      setLoading(false)
      return
    }
    api<PublicUser>('/api/auth/me')
      .then(setUser)
      .catch(() => clearSession())
      .finally(() => setLoading(false))
  }, [])

  const auth = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    setUser,
    login: (payload, remember) => {
      setSession(payload, remember)
      setUser(payload.user)
      if (payload.user.theme) setPref(payload.user.theme)
    },
    logout: async () => {
      const refreshToken = refreshTokenValue()
      try { await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }) } catch { /* session already ended */ }
      clearSession()
      setUser(null)
    },
  }), [user, loading])

  const push = (message: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, message, tone }])
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3200)
  }

  return (
    <AuthContext.Provider value={auth}>
      <ThemeContext.Provider value={{ theme, toggle: () => setPref(theme === 'dark' ? 'light' : 'dark'), setTheme: setPref }}>
        <ToastContext.Provider value={{ push }}>
          {children}
          <div className="fixed bottom-4 right-4 z-[80] flex w-[min(100%-2rem,22rem)] flex-col gap-2" aria-live="polite">
            {toasts.map((toast) => (
              <div key={toast.id} className={`rounded-md border px-3 py-2 text-sm shadow-card ${toast.tone === 'err' ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-100' : 'border-emerald-200 bg-white text-ink dark:border-emerald-900 dark:bg-card'}`}>
                {toast.message}
              </div>
            ))}
          </div>
        </ToastContext.Provider>
      </ThemeContext.Provider>
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('Auth provider missing')
  return value
}
export function useTheme() {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('Theme provider missing')
  return value
}
export function useToast() {
  const value = useContext(ToastContext)
  if (!value) throw new Error('Toast provider missing')
  return value
}
