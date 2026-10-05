import { describe, expect, it } from 'vitest'
import { isolationStyleScore, zScore } from './utils/stats.js'
import { buildSimplePdf } from './utils/pdf.js'
import { inspectQuestion } from './services/ai/routeQuestion.js'

describe('anomaly statistics', () => {
  it('flags a value far above a calm window', () => {
    const baseline = [500, 800, 1200, 700, 900, 650, 1100]
    expect(zScore(baseline, 85000)).toBeGreaterThan(3)
    expect(isolationStyleScore(baseline, 85000)).toBeGreaterThan(0.5)
  })
})

describe('pdf export', () => {
  it('contains the report title and a real metric', () => {
    const pdf = buildSimplePdf('Daily Operations Report', ['Total transactions: 1200', 'Synthetic demonstration data.'])
    const text = pdf.toString('latin1')
    expect(text.startsWith('%PDF')).toBe(true)
    expect(text).toContain('Daily Operations Report')
    expect(text).toContain('Total transactions: 1200')
    expect(pdf.length).toBeGreaterThan(200)
  })
})

describe('assistant routing', () => {
  it('uses institution metrics for the failure-rate question', () => {
    expect(inspectQuestion('Which institution has the highest failure rate?').tool).toBe('getInstitutionMetrics')
  })

  it('searches transactions above a stated amount', () => {
    const routed = inspectQuestion('Show transactions above Rs. 100,000.')
    expect(routed.tool).toBe('searchTransactions')
    expect(routed.minAmount).toBe(100000)
  })

  it('refuses arbitrary SQL', () => {
    expect(inspectQuestion('DROP TABLE transactions').refusal).toMatch(/cannot run arbitrary SQL/i)
  })
})
