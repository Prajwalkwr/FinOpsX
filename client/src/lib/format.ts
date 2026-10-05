import { useSearchParams } from 'react-router-dom'

const TZ = 'Asia/Kathmandu'
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const timeOnly = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const dateOnly = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' })
const shortTick = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
const dayTick = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short' })

export function fmtDateTime(iso?: string | null) {
  return iso ? dateTime.format(new Date(iso)) : '—'
}
export function fmtTime(iso?: string | null) {
  return iso ? timeOnly.format(new Date(iso)) : '—'
}
export function fmtDate(iso?: string | null) {
  return iso ? dateOnly.format(new Date(iso)) : '—'
}
export function chartTick(iso: string, unit?: string) {
  return unit === 'day' ? dayTick.format(new Date(iso)) : shortTick.format(new Date(iso))
}

export function relTime(iso?: string | null) {
  if (!iso) return '—'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hr ago`
  return `${Math.round(hours / 24)} days ago`
}

export function fmtMs(ms?: number | null) {
  if (ms == null || Number.isNaN(ms)) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${Math.round(ms)}ms`
}

export function fmtPct(value?: number | null, digits = 1) {
  return value == null || Number.isNaN(value) ? '—' : `${value.toFixed(digits)}%`
}

export function humanize(value?: string | null) {
  if (!value) return '—'
  return value.replaceAll('_', ' ').toLowerCase().replace(/^\w/, (char) => char.toUpperCase())
}

/** Filter state stored in the URL so deep links (from the AI assistant, alerts, RCA) open pre-filtered views. */
export function useUrlFilters<T extends Record<string, string>>(defaults: T) {
  const [params, setParams] = useSearchParams()
  const values = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, params.get(key) ?? fallback])) as T
  const set = (patch: Partial<T>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '' || value === defaults[key]) next.delete(key)
      else next.set(key, String(value))
    }
    if (!('page' in patch)) next.delete('page')
    setParams(next, { replace: true })
  }
  return [values, set] as const
}

export function queryString(values: Record<string, string | number | undefined | null>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '' && value !== 'ALL') params.set(key, String(value))
  }
  return params.toString()
}
