export function mean(values: number[]): number {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const avg = mean(values)
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

export function zScore(values: number[], target: number): number {
  const sd = stdev(values)
  if (sd === 0) return 0
  return (target - mean(values)) / sd
}

export function movingAverage(values: number[], window: number): number[] {
  return values.map((_, index) => {
    const start = Math.max(0, index - window + 1)
    return mean(values.slice(start, index + 1))
  })
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const low = Math.floor(index)
  const high = Math.ceil(index)
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

/** Pearson correlation coefficient. Returns 0 when either series is flat or too short. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  const x = a.slice(0, n)
  const y = b.slice(0, n)
  const mx = mean(x)
  const my = mean(y)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i += 1) {
    num += (x[i] - mx) * (y[i] - my)
    dx += (x[i] - mx) ** 2
    dy += (y[i] - my) ** 2
  }
  if (dx === 0 || dy === 0) return 0
  return num / Math.sqrt(dx * dy)
}

/** Lightweight deterministic isolation-style score kept for the per-transaction amount outlier check. */
export function isolationStyleScore(values: number[], target: number): number {
  if (values.length < 4) return 0
  const lowBound = Math.min(...values)
  const highBound = Math.max(...values)
  if (target > highBound || target < lowBound) return 0.92
  let subset = values.slice()
  let depth = 0
  const maxDepth = 8
  for (let i = 0; i < maxDepth && subset.length > 1; i += 1) {
    const low = Math.min(...subset)
    const high = Math.max(...subset)
    if (low === high) break
    const split = low + ((i + 1) / (maxDepth + 1)) * (high - low)
    const next = target < split ? subset.filter((value) => value < split) : subset.filter((value) => value >= split)
    if (!next.length) break
    subset = next
    depth += 1
  }
  return Number((1 - depth / maxDepth).toFixed(3))
}

export type SpikeResult = {
  anomalous: boolean
  method: 'z-score' | 'threshold' | 'insufficient-data'
  normal: number
  observed: number
  z: number | null
  ratio: number | null
  score: number
  points: number
}

/**
 * Compares an observed window value against a moving baseline.
 * With enough baseline points it requires both a z-score and a ratio over the baseline mean.
 * Without enough points it falls back to a ratio against a longer-term normal value (threshold detection).
 */
export function evaluateSpike(input: {
  baseline: number[]
  observed: number
  fallbackNormal?: number | null
  minPoints?: number
  zThreshold?: number
  minRatio?: number
  minObserved?: number
}): SpikeResult {
  const minPoints = input.minPoints ?? 5
  const zThreshold = input.zThreshold ?? 3
  const minRatio = input.minRatio ?? 1.8
  const minObserved = input.minObserved ?? 0
  const observed = input.observed
  if (input.baseline.length >= minPoints) {
    const m = mean(input.baseline)
    const sd = stdev(input.baseline)
    const z = sd > 0 ? (observed - m) / sd : observed > m ? 99 : 0
    const ratio = m > 0 ? observed / m : observed > 0 ? 99 : 1
    const anomalous = observed >= minObserved && z >= zThreshold && ratio >= minRatio
    return { anomalous, method: 'z-score', normal: m, observed, z, ratio, score: anomalous ? Math.min(0.99, 0.55 + Math.min(z, 12) / 27) : Math.max(0, Math.min(0.5, z / 10)), points: input.baseline.length }
  }
  if (input.fallbackNormal != null && input.fallbackNormal > 0) {
    const ratio = observed / input.fallbackNormal
    const anomalous = observed >= minObserved && ratio >= minRatio * 1.4
    return { anomalous, method: 'threshold', normal: input.fallbackNormal, observed, z: null, ratio, score: anomalous ? Math.min(0.95, 0.5 + ratio / 20) : 0, points: input.baseline.length }
  }
  return { anomalous: false, method: 'insufficient-data', normal: 0, observed, z: null, ratio: null, score: 0, points: input.baseline.length }
}
