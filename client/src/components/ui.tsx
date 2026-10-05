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

const GOOD = new Set(['SUCCESS', 'SETTLED', 'OPERATIONAL', 'RESOLVED', 'CLOSED', 'ACTIVE', 'MATCHED', 'COMPLETED', 'POST_INCIDENT_REVIEW', 'LOW', 'MATCH'])
const BAD = new Set(['FAILED', 'INCIDENT', 'CRITICAL', 'DEACTIVATED', 'MISMATCH', 'DETECTED', 'LOCKED', 'OPEN', 'DELAYED', 'REVERSED'])
const WARN = new Set(['PENDING', 'DEGRADED', 'HIGH', 'MEDIUM', 'INVESTIGATING', 'ACKNOWLEDGED', 'IDENTIFIED', 'MITIGATING', 'REVIEW', 'RUNNING', 'QUEUED', 'PROCESSING', 'INITIATED', 'MAINTENANCE'])

export function statusTone(status: string): 'good' | 'bad' | 'warn' | 'info' | 'neutral' {
  if (GOOD.has(status)) return 'good'
  if (BAD.has(status)) return 'bad'
  if (WARN.has(status)) return 'warn'
  if (status === 'DISMISSED' || status === 'CONFIRMED' || status === 'NOT_STARTED') return 'neutral'
  return 'info'
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone(status)}>{status.replaceAll('_', ' ')}</Badge>
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  const color = tone === 'bad' ? 'text-red-700 dark:text-red-300' : tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : tone === 'good' ? 'text-emerald-700 dark:text-emerald-300' : ''
  return (
    <div className="rounded-3xl border border-line bg-card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums tracking-tight ${color}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

export function Select({ label, value, onChange, options, className = '' }: { label: string; value: string; onChange: (value: string) => void; options: Array<string | [string, string]>; className?: string }) {
  return (
    <label className={`text-xs text-muted ${className}`}>
      <span className="sr-only">{label}</span>
      <select aria-label={label} className="rounded-full border border-line bg-card px-3 py-1.5 text-sm text-ink" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => {
          const [key, text] = Array.isArray(option) ? option : [option, option.replaceAll('_', ' ')]
          return <option key={key} value={key}>{text}</option>
        })}
      </select>
    </label>
  )
}

export function Table({ head, children, minWidth = 640 }: { head: ReactNode[]; children: ReactNode; minWidth?: number }) {
  return (
    <div className="table-wrap rounded-2xl border border-line bg-card">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead className="text-xs text-muted"><tr>{head.map((cell, index) => <th key={index} scope="col" className="px-3 py-2 font-medium">{cell}</th>)}</tr></thead>
        <tbody className="[&>tr]:border-t [&>tr]:border-line [&_td]:px-3 [&_td]:py-2">{children}</tbody>
      </table>
    </div>
  )
}

export function Card({ title, action, children, className = '' }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-3xl border border-line bg-card p-4 shadow-card ${className}`}>
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

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-950/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div ref={panel} tabIndex={-1} className={`max-h-[90vh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-auto rounded-2xl bg-card p-4 shadow-xl outline-none`}>
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

export function Drawer({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-navy-950/40" role="dialog" aria-modal="true" aria-label={title}>
      <button className="h-full flex-1" aria-label="Close drawer" onClick={onClose} />
      <div className={`h-full ${wide ? 'w-[min(100%,40rem)]' : 'w-[min(100%,22rem)]'} overflow-auto bg-card p-4 shadow-xl`}>
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
