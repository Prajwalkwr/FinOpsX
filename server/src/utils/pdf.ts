const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[—–]/g, '-'],
  [/→/g, '->'],
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/[·•]/g, '-'],
  [/×/g, 'x'],
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"],
  [/…/g, '...'],
]

/** Helvetica in a minimal PDF only covers ASCII reliably, so typographic characters are mapped and the rest dropped. */
export function toPdfAscii(value: string): string {
  let text = value
  for (const [pattern, replacement] of REPLACEMENTS) text = text.replace(pattern, replacement)
  return text.replace(/[^\x20-\x7E]/g, '')
}

function escapePdfText(value: string): string {
  return toPdfAscii(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

export function wrapLine(line: string, width = 96): string[] {
  const text = toPdfAscii(line)
  if (text.length <= width) return [text]
  const indent = '   '
  const out: string[] = []
  let current = ''
  const limit = () => (out.length === 0 ? width : width - indent.length)
  const words = text.split(' ').flatMap((word) => {
    const max = width - indent.length
    if (word.length <= max) return [word]
    return word.match(new RegExp(`.{1,${max}}`, 'g')) ?? [word]
  })
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (candidate.length > limit()) {
      if (current) out.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) out.push(current)
  return out.map((part, index) => (index === 0 ? part : `${indent}${part}`))
}

export function buildSimplePdf(title: string, lines: string[], footer = 'FinOpsX - Demo Environment - Synthetic Data Only. Not affiliated with or endorsed by F1Soft.'): Buffer {
  const pages: string[][] = []
  const capacity = 48
  const body = ['', ...lines.flatMap((line) => wrapLine(line))]
  for (let i = 0; i < body.length; i += capacity) pages.push(body.slice(i, i + capacity))
  if (!pages.length) pages.push([''])

  const objects: string[] = []
  const pageIds: number[] = []
  let nextId = 3
  const fontId = 3 + pages.length * 2
  pages.forEach((pageLines, index) => {
    const pageId = nextId
    const contentId = nextId + 1
    nextId += 2
    pageIds.push(pageId)
    const commands = ['BT', '48 750 Td', '14 TL']
    if (index === 0) commands.push(`/F1 16 Tf (${escapePdfText(title).slice(0, 80)}) Tj`, 'T*')
    commands.push('/F1 10 Tf')
    for (const line of pageLines) commands.push(`(${escapePdfText(line)}) Tj`, 'T*')
    commands.push('ET', 'BT', '/F1 8 Tf', '48 30 Td', `(${escapePdfText(`${footer}  Page ${index + 1} of ${pages.length}`)}) Tj`, 'ET')
    const stream = commands.join('\n')
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
  })
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`
  objects[fontId] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let id = 1; id <= fontId; id += 1) {
    offsets[id] = Buffer.byteLength(pdf)
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${fontId + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let id = 1; id <= fontId; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer << /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}
