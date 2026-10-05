import { describe, expect, it } from 'vitest'
import { evaluateSpike, isolationStyleScore, pearson, percentile, zScore } from './utils/stats.js'
import { buildSimplePdf, toPdfAscii, wrapLine } from './utils/pdf.js'
import { toCsv } from './utils/csv.js'
import { parseQuestion, structuredQuerySchema } from './services/ai/queryParser.js'
import { routeIntent } from './services/ai/assistant.js'
import { canTransition } from './services/incidentService.js'
import { transitiveDependents } from './services/serviceMapService.js'
import { reportTitle } from './services/reportService.js'
import { generateCandidate, scenarioEffects } from './simulator/engine.js'

describe('anomaly statistics', () => {
  it('flags a value far above a calm window', () => {
    const baseline = [500, 800, 1200, 700, 900, 650, 1100]
    expect(zScore(baseline, 85000)).toBeGreaterThan(3)
    expect(isolationStyleScore(baseline, 85000)).toBeGreaterThan(0.5)
  })

  it('uses z-score when enough baseline points exist', () => {
    const result = evaluateSpike({ baseline: [1800, 1750, 1900, 1820, 1780, 1850, 1810], observed: 7400 })
    expect(result.method).toBe('z-score')
    expect(result.anomalous).toBe(true)
    expect(result.normal).toBeGreaterThan(1700)
    expect(result.observed).toBe(7400)
  })

  it('does not flag normal variation', () => {
    const result = evaluateSpike({ baseline: [1800, 1750, 1900, 1820, 1780, 1850, 1810], observed: 1870 })
    expect(result.anomalous).toBe(false)
  })

  it('falls back to a threshold ratio with sparse history and reports insufficient data with none', () => {
    expect(evaluateSpike({ baseline: [2], observed: 20, fallbackNormal: 2 }).method).toBe('threshold')
    const empty = evaluateSpike({ baseline: [], observed: 5 })
    expect(empty.method).toBe('insufficient-data')
    expect(empty.anomalous).toBe(false)
  })

  it('computes percentiles and correlation', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 0.5)).toBeCloseTo(50.5)
    expect(percentile(values, 0.95)).toBeCloseTo(95.05)
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1)
  })
})

describe('pdf export', () => {
  it('contains the report title, a real metric and the demo footer', () => {
    const pdf = buildSimplePdf('Daily Operations Report', ['Total transactions: 1200', 'Synthetic demonstration data.'])
    const text = pdf.toString('latin1')
    expect(text.startsWith('%PDF')).toBe(true)
    expect(text).toContain('Daily Operations Report')
    expect(text).toContain('Total transactions: 1200')
    expect(text).toContain('Not affiliated with or endorsed by F1Soft')
  })

  it('maps non-ASCII characters and wraps long lines', () => {
    expect(toPdfAscii('Rs. 1,000 — ≥ 5')).not.toMatch(/[^\x20-\x7E]/)
    expect(wrapLine('word '.repeat(60), 96).every((line) => line.length <= 96)).toBe(true)
  })
})

describe('csv export', () => {
  it('escapes quotes and neutralises spreadsheet formulas', () => {
    const csv = toCsv(['a', 'b'], [['=SUM(A1)', 'say "hi"'], [1, null]])
    const lines = csv.split(/\r?\n/)
    expect(lines[0]).toBe('a,b')
    expect(lines[1]).toContain("'=SUM(A1)")
    expect(lines[1]).toContain('"say ""hi"""')
    expect(lines[2]).toBe('1,')
  })
})

describe('ask your data parser', () => {
  it('turns a failure-rate question into a grouped aggregate', () => {
    const parsed = parseQuestion('Which bank has the highest failure rate today?')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.query.entity).toBe('transactions')
    expect(parsed.query.groupBy).toBe('institution')
    expect(parsed.query.metric).toBe('failure_rate')
    expect(parsed.query.range).toBe('today')
  })

  it('parses amounts with lakh units', () => {
    const parsed = parseQuestion('Show failed transactions above 1 lakh in the last 7 days')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.query.filters.minAmount).toBe(100000)
    expect(parsed.query.filters.status).toEqual(['FAILED'])
    expect(parsed.query.range).toBe('7d')
  })

  it('refuses SQL and money movement', () => {
    const sql = parseQuestion('DROP TABLE "Transaction"; --')
    expect(sql.ok).toBe(false)
    if (!sql.ok) expect(sql.reason).toBe('refused')
    const money = parseQuestion('transfer money from Demo Bank A to my account')
    expect(money.ok).toBe(false)
    if (!money.ok) expect(money.reason).toBe('refused')
  })

  it('says it lacks data for unrelated questions', () => {
    const parsed = parseQuestion('What is the weather in Kathmandu?')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toBe("I don't have enough data to answer that.")
  })

  it('rejects structured queries outside the whitelist', () => {
    expect(structuredQuerySchema.safeParse({ entity: 'users', mode: 'list', range: '24h', filters: {}, limit: 10 }).success).toBe(false)
    expect(structuredQuerySchema.safeParse({ entity: 'transactions', mode: 'list', range: '24h', filters: { merchant: "x'; DROP TABLE" }, limit: 10 }).success).toBe(false)
    expect(structuredQuerySchema.safeParse({ entity: 'transactions', mode: 'list', range: '24h', filters: {}, limit: 5000 }).success).toBe(false)
  })
})

describe('assistant routing', () => {
  it('routes incident and explanation questions to the right tools', () => {
    expect(routeIntent('Explain INC-2041')).toBe('incidentDetail')
    expect(routeIntent('Why did failures increase in the last hour?')).toBe('explainChange')
  })
})

describe('incident lifecycle', () => {
  it('moves forward only and reaches post-incident review from resolved', () => {
    expect(canTransition('DETECTED', 'ACKNOWLEDGED')).toBe(true)
    expect(canTransition('INVESTIGATING', 'DETECTED')).toBe(false)
    expect(canTransition('MITIGATING', 'POST_INCIDENT_REVIEW')).toBe(false)
    expect(canTransition('RESOLVED', 'POST_INCIDENT_REVIEW')).toBe(true)
  })
})

describe('service dependency impact', () => {
  it('finds services that transitively depend on a degraded service', () => {
    const edges = [
      { from: 'gateway', to: 'payment' },
      { from: 'payment', to: 'bank' },
      { from: 'settlement', to: 'payment' },
      { from: 'notification', to: 'queue' },
    ]
    expect(transitiveDependents('bank', edges).sort()).toEqual(['gateway', 'payment', 'settlement'])
    expect(transitiveDependents('queue', edges)).toEqual(['notification'])
  })
})

describe('report titles', () => {
  it('names reports by the Asia/Kathmandu calendar day', () => {
    const from = new Date('2026-10-04T18:15:00.000Z')
    expect(reportTitle('DAILY_OPERATIONS', from, new Date('2026-10-05T18:15:00.000Z'))).toBe('Daily Operations Report · 2026-10-05')
    expect(reportTitle('INCIDENT_REPORT', from, new Date('2026-10-11T18:15:00.000Z'))).toBe('Incident Report · 2026-10-05 to 2026-10-11')
  })
})

describe('simulated transactions', () => {
  it('only records TIMEOUT failures at or above the 8 second limit', () => {
    let seed = 7
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const effects = scenarioEffects({ scenario: 'BANK_API_LATENCY', scenarioIntensity: 1, tpm: 60, failureRate: 0.04, pendingRate: 0.02, highValueRate: 0.01 })
    const institutions = ['DBA', 'DBB', 'DBC', 'DWL'].map((code) => ({ id: code, code, name: code }))
    const merchants = [{ id: 'M1', code: 'M001', name: 'Demo Merchant' }]
    const timeouts = Array.from({ length: 2000 }, () => generateCandidate({ effects, averageAmount: 3500, institutions, merchants, rng })).filter((tx) => tx.failureReason === 'TIMEOUT')
    expect(timeouts.length).toBeGreaterThan(0)
    expect(timeouts.every((tx) => tx.responseTimeMs >= 8000)).toBe(true)
  })
})
