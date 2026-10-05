function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

export function buildSimplePdf(title: string, lines: string[]): Buffer {
  const pages: string[][] = []
  const capacity = 46
  const body = [title, '', ...lines]
  for (let i = 0; i < body.length; i += capacity) pages.push(body.slice(i, i + capacity))
  if (!pages.length) pages.push([title])

  const objects: string[] = []
  const pageIds: number[] = []
  let nextId = 3
  const fontId = 3 + pages.length * 2
  pages.forEach((pageLines, index) => {
    const pageId = nextId
    const contentId = nextId + 1
    nextId += 2
    pageIds.push(pageId)
    const commands = ['BT', '/F1 11 Tf', '48 750 Td', '14 TL']
    pageLines.forEach((line, lineIndex) => {
      const text = escapePdfText(line).slice(0, 110)
      if (lineIndex === 0 && index === 0) {
        commands.push(`/F1 16 Tf (${escapePdfText(title).slice(0, 80)}) Tj`, '/F1 11 Tf', 'T*')
      } else if (!(index === 0 && lineIndex === 0)) {
        commands.push(`(${text}) Tj`, 'T*')
      }
    })
    commands.push('ET')
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
