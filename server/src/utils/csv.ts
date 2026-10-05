export type Cell = string | number | null

/** RFC 4180 CSV with formula-injection protection for spreadsheet clients. */
export function toCsv(columns: string[], rows: Cell[][]) {
  const escape = (value: Cell) => {
    if (value == null) return ''
    const text = String(value)
    const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return [columns.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))].join('\n')
}
