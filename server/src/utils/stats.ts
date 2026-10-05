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
    const slice = values.slice(start, index + 1)
    return mean(slice)
  })
}

/** Lightweight deterministic isolation-style score for the simulated detector. */
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
