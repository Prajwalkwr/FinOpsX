import { Component, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'quiet' }) {
  const styles = {
    primary: 'bg-brand text-white hover:bg-[#2457d6]',
    ghost: 'border border-line bg-card hover:bg-[#f6f8fb] dark:hover:bg-white/5',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    quiet: 'text-muted hover:bg-[#f3f5f8] dark:hover:bg-white/5',
  }[variant]
  return <button className={`inline-flex items-center justify-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`} {...props} />
}

export function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-red-700">{error}</span> : null}
    </label>
  )
}

export const inputClass = 'w-full rounded-xl border border-line bg-card px-3 py-2 text-sm outline-none ring-brand focus:ring-2'

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) {
  const styles = {
    neutral: 'bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-200',
    good: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
    warn: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
    bad: 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200',
    info: 'bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  }[tone]
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}>{children}</span>
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'SUCCESS' || status === 'OPERATIONAL' || status === 'RESOLVED' || status === 'CLOSED' || status === 'ACTIVE' || status === 'CONFIRMED'
    ? 'good'
    : status === 'FAILED' || status === 'INCIDENT' || status === 'CRITICAL' || status === 'DEACTIVATED'
      ? 'bad'
      : status === 'PENDING' || status === 'DEGRADED' || status === 'HIGH' || status === 'MEDIUM' || status === 'INVESTIGATING' || status === 'DETECTED'
        ? 'warn'
        : 'info'
  return <Badge tone={tone}>{status.replaceAll('_', ' ')}</Badge>
}

export function Card({ title, action, children, className = '' }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-3xl border border-line bg-card p-4 shadow-card ${className}`}>
      {title ? <header className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{title}</h2>{action}</header> : null}
      {children}
    </section>
  )
}

export function Skeleton({ className = 'h-24' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-slate-200 dark:bg-white/10 ${className}`} />
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return <div className="rounded-md border border-dashed border-line px-4 py-10 text-center"><p className="font-medium">{title}</p>{detail ? <p className="mt-1 text-sm text-muted">{detail}</p> : null}</div>
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
      <p>{message ?? 'Unable to connect to FinOpsX services.'}</p>
      {onRetry ? <Button className="mt-3" variant="ghost" onClick={onRetry}>Retry</Button> : null}
    </div>
  )
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-950/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg bg-card p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-base font-semibold">{title}</h2><Button variant="quiet" onClick={onClose} aria-label="Close">Close</Button></div>
        {children}
      </div>
    </div>
  )
}

export function ConfirmDialog({ title, body, confirmLabel, danger, busy, onConfirm, onClose }: { title: string; body: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-muted">{body}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>{busy ? 'Working…' : confirmLabel}</Button>
      </div>
    </Modal>
  )
}

export function Drawer({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-navy-950/40" role="dialog" aria-label={title}>
      <button className="h-full flex-1" aria-label="Close drawer" onClick={onClose} />
      <div className="h-full w-[min(100%,22rem)] overflow-auto bg-card p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">{title}</h2><Button variant="quiet" onClick={onClose}>Close</Button></div>
        {children}
      </div>
    </div>
  )
}

export function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (page: number) => void }) {
  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      <span className="text-muted">Page {page} of {totalPages}</span>
      <div className="flex gap-2">
        <Button variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button variant="ghost" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() { return { error: true } }
  render() {
    if (this.state.error) {
      return <div className="grid min-h-screen place-items-center p-6"><div className="max-w-md text-center"><h1 className="text-xl font-semibold">Something went wrong.</h1><Button className="mt-4" onClick={() => window.location.reload()}>Reload page</Button></div></div>
    }
    return this.props.children
  }
}

export function useDebounced<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export function Spark({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dots = Array.from({ length: 48 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.6 + 0.4, s: Math.random() * 0.0004 + 0.0001 }))
    let frame = 0
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect()
      canvas.width = width * devicePixelRatio
      canvas.height = height * devicePixelRatio
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      dots.forEach((dot) => {
        if (!reduce) dot.y -= dot.s
        if (dot.y < 0) dot.y = 1
        ctx.fillStyle = 'rgba(255,255,255,.75)'
        ctx.beginPath()
        ctx.arc(dot.x * width, dot.y * height, dot.r, 0, Math.PI * 2)
        ctx.fill()
      })
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [])
  return <canvas ref={ref} className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} aria-hidden="true" />
}
