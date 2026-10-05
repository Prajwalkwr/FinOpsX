export type TimeRange = {
  from: Date
  to: Date
  unit: 'minute' | 'hour' | 'day'
  label: string
}

const KATHMANDU_OFFSET_MS = (5 * 60 + 45) * 60 * 1000

export function kathmanduNow(date = new Date()) {
  return new Date(date.getTime() + KATHMANDU_OFFSET_MS)
}

export function resolveRange(input: {
  range?: string
  from?: string
  to?: string
}): TimeRange {
  const now = new Date()
  const key = input.range || '24h'
  const hours: Record<string, number> = {
    '1h': 1,
    '6h': 6,
    '24h': 24,
    '7d': 24 * 7,
    '30d': 24 * 30,
  }
  if (key === 'custom' && input.from && input.to) {
    const from = new Date(input.from)
    const to = new Date(input.to)
    const span = to.getTime() - from.getTime()
    return {
      from,
      to,
      unit: span <= 6 * 3600_000 ? 'minute' : span <= 3 * 86400_000 ? 'hour' : 'day',
      label: 'Custom range',
    }
  }
  if (key === 'today' || key === 'yesterday') {
    const local = kathmanduNow(now)
    const startUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - KATHMANDU_OFFSET_MS
    const from = new Date(key === 'yesterday' ? startUtc - 86400_000 : startUtc)
    const to = new Date(key === 'yesterday' ? startUtc - 1 : now.getTime())
    return { from, to, unit: 'hour', label: key === 'today' ? 'Today' : 'Yesterday' }
  }
  const span = hours[key] ?? 24
  const unit = span <= 6 ? 'minute' : span <= 48 ? 'hour' : 'day'
  return {
    from: new Date(now.getTime() - span * 3600_000),
    to: now,
    unit,
    label: key,
  }
}
