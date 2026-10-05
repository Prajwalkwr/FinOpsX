import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { io, type Socket } from 'socket.io-client'
import { api, getAccessToken } from './api'
import { useAuth } from './contexts'

export type RealtimeState = 'connecting' | 'live' | 'reconnecting' | 'offline'
export type LiveSnapshot = {
  at: string
  transactionsLastMinute: number
  window5m: { total: number; successRate: number; failureRate: number; avgLatencyMs: number; value: number; apiAvailability: number | null }
  activeIncidents: number
  openAnomalies: number
  pendingTransactions: number
  systemStatus: string
  degradedServices: Array<{ key: string; name: string; status: string }>
}
type Listener = (payload: unknown) => void

/** Which cached queries each server event makes stale. Invalidations are batched so bursts cause one refetch. */
const INVALIDATES: Record<string, string[]> = {
  'transaction:new': ['dashboard', 'transactions'],
  'transaction:updated': ['dashboard', 'transactions', 'transaction'],
  'incident:created': ['incidents', 'incident', 'dashboard', 'service-map'],
  'incident:updated': ['incidents', 'incident', 'dashboard'],
  'incident:resolved': ['incidents', 'incident', 'dashboard', 'service-map', 'simulator'],
  'anomaly:detected': ['anomalies', 'dashboard'],
  'anomaly:updated': ['anomalies', 'anomaly'],
  'system:status': ['system', 'service-map', 'dashboard', 'institutions', 'institution', 'apis'],
  'service:degraded': ['system', 'service-map'],
  'service:recovered': ['system', 'service-map'],
  'infrastructure:sample': ['system'],
  'job:updated': ['jobs', 'job'],
  'reconciliation:completed': ['reconciliation'],
  'settlement:updated': ['settlements', 'reconciliation'],
  'dataquality:scanned': ['data-quality'],
  'simulator:status': ['simulator', 'dashboard'],
  'notification:created': ['notifications'],
}

type RealtimeValue = {
  state: RealtimeState
  lastEventAt: number | null
  snapshot: LiveSnapshot | null
  subscribe: (event: string, listener: Listener) => () => void
  reconnect: () => void
}

const RealtimeContext = createContext<RealtimeValue | null>(null)

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [state, setState] = useState<RealtimeState>('offline')
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const listeners = useRef(new Map<string, Set<Listener>>())
  const pending = useRef(new Set<string>())
  const flushTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!user) return
    const url = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL || undefined
    const socket = io(url, {
      auth: (cb) => cb({ token: getAccessToken() }),
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    })
    socketRef.current = socket
    setState('connecting')

    const flush = () => {
      flushTimer.current = undefined
      for (const key of pending.current) queryClient.invalidateQueries({ queryKey: [key] })
      pending.current.clear()
    }
    // Throttled rather than debounced: a steady event stream must still flush at least every 1.5s.
    const schedule = (keys: string[]) => {
      keys.forEach((key) => pending.current.add(key))
      if (flushTimer.current === undefined) flushTimer.current = window.setTimeout(flush, 1500)
    }

    socket.on('connect', () => setState('live'))
    socket.on('realtime:ready', () => {
      setState('live')
      api<LiveSnapshot>('/api/realtime/snapshot').then(setSnapshot).catch(() => undefined)
    })
    socket.on('disconnect', (reason) => {
      setState(reason === 'io client disconnect' ? 'offline' : 'reconnecting')
    })
    socket.io.on('reconnect_attempt', () => setState('reconnecting'))
    socket.io.on('reconnect', () => {
      setState('live')
      // Anything emitted while disconnected was missed; refresh the views once.
      schedule(['dashboard', 'transactions', 'incidents', 'anomalies', 'system', 'notifications', 'jobs', 'simulator'])
    })
    socket.on('connect_error', async (error) => {
      setState('reconnecting')
      if (/unauthor|token|jwt/i.test(error.message)) {
        // Touching an authenticated endpoint refreshes the access token; the next attempt reads it via auth().
        await api('/api/auth/me').catch(() => undefined)
      }
    })
    socket.on('metrics:tick', (payload: LiveSnapshot) => {
      setSnapshot(payload)
      setLastEventAt(Date.now())
    })
    socket.onAny((event: string, payload: unknown) => {
      if (event !== 'metrics:tick') setLastEventAt(Date.now())
      const keys = INVALIDATES[event]
      if (keys) schedule(keys)
      listeners.current.get(event)?.forEach((listener) => listener(payload))
    })

    return () => {
      window.clearTimeout(flushTimer.current)
      flushTimer.current = undefined
      pending.current.clear()
      socket.removeAllListeners()
      socket.io.removeAllListeners()
      socket.close()
      socketRef.current = null
      setState('offline')
    }
  }, [user?.id, queryClient])

  const value: RealtimeValue = {
    state,
    lastEventAt,
    snapshot,
    subscribe: (event, listener) => {
      const set = listeners.current.get(event) ?? new Set<Listener>()
      set.add(listener)
      listeners.current.set(event, set)
      return () => { set.delete(listener) }
    },
    reconnect: () => { socketRef.current?.connect() },
  }
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

export function useRealtime() {
  const value = useContext(RealtimeContext)
  if (!value) throw new Error('Realtime provider missing')
  return value
}

/** Subscribes for the component's lifetime; the latest handler is always used without resubscribing. */
export function useRealtimeEvent<T = unknown>(event: string, handler: (payload: T) => void) {
  const { subscribe } = useRealtime()
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => subscribe(event, (payload) => ref.current(payload as T)), [event, subscribe])
}

export function LiveIndicator() {
  const { state, lastEventAt, reconnect } = useRealtime()
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 5000)
    return () => window.clearInterval(timer)
  }, [])
  const ago = lastEventAt ? Math.round((Date.now() - lastEventAt) / 1000) : null
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : state === 'reconnecting' ? 'Reconnecting' : 'Offline'
  const dot = state === 'live' ? 'bg-emerald-500' : state === 'offline' ? 'bg-slate-400' : 'bg-amber-500'
  return (
    <button
      type="button"
      onClick={state === 'live' ? undefined : reconnect}
      className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs font-medium"
      title={ago != null ? `Last update ${ago}s ago` : 'Waiting for the first update'}
      aria-live="polite"
      aria-label={`Realtime connection: ${label}${ago != null ? `, last update ${ago} seconds ago` : ''}`}
    >
      <span className={`h-2 w-2 rounded-full ${dot} ${state === 'live' ? 'animate-pulse' : ''}`} aria-hidden="true" />
      {label}
    </button>
  )
}
