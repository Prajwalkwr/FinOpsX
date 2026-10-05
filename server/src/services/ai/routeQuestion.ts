export type ToolName =
  | 'getDashboardMetrics'
  | 'getTransactionMetrics'
  | 'searchTransactions'
  | 'getInstitutionMetrics'
  | 'getSystemHealth'
  | 'getIncidents'
  | 'getAnomalies'
  | 'getFailureReasons'
  | 'getHourlyVolume'
  | 'getApiMetrics'
  | 'generateDailyReport'
  | 'explainFailures'

const SQL_PATTERN = /\b(drop|truncate|alter)\b|\bdelete\s+from\b|;\s*--|union\s+select/i

export function inspectQuestion(question: string): { tool: ToolName; refusal?: string; minAmount?: number } {
  const q = question.toLowerCase()
  if (SQL_PATTERN.test(q) || q.includes('arbitrary sql')) {
    return {
      tool: 'getDashboardMetrics',
      refusal: 'I cannot run arbitrary SQL or change financial data. I can only use approved operational read tools.',
    }
  }
  const amountMatch = q.replace(/,/g, '').match(/(\d{3,})/)
  const minAmount = amountMatch ? Number(amountMatch[1]) : undefined
  if (q.includes('report')) return { tool: 'generateDailyReport' }
  if (q.includes('unusual') || q.includes('anomal')) return { tool: 'getAnomalies' }
  if (q.includes('slow') || (q.includes('api') && (q.includes('latency') || q.includes('slow')))) return { tool: 'getApiMetrics' }
  if (q.includes('busiest') || q.includes('hour')) return { tool: 'getHourlyVolume' }
  if (q.includes('above') || q.includes('over') || q.includes('show transactions') || (minAmount && minAmount >= 1000 && q.includes('transaction'))) {
    return { tool: 'searchTransactions', minAmount }
  }
  if (q.includes('why') && (q.includes('fail') || q.includes('increase'))) return { tool: 'explainFailures' }
  if (q.includes('payment method')) return { tool: 'getFailureReasons' }
  if (q.includes('incident')) return { tool: 'getIncidents' }
  if (q.includes('health') || q.includes('system status')) return { tool: 'getSystemHealth' }
  if (q.includes('bank') || q.includes('institution') || q.includes('compare') || q.includes('fail')) return { tool: 'getInstitutionMetrics' }
  return { tool: 'getDashboardMetrics' }
}
