/**
 * A synthetic multi-page PDF for tests. Each page is a list of text lines (an empty list is a
 * page with no text layer, as a scan has). Never build fixtures from a customer's statement.
 */
export function syntheticPdf(pages: string[][]): Buffer {
  const fontObj = 3 + pages.length * 2;
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ];
  pages.forEach((lines, i) => {
    const stream = lines.map((l, n) => `BT /F1 10 Tf 40 ${780 - n * 14} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** `count` statement-looking rows (about 60 characters each). */
export function statementRows(count: number, tag: string): string[] {
  return Array.from({ length: count }, (_, i) => `2026-03-${String((i % 28) + 1).padStart(2, '0')} ${tag} PAYMENT REF${i} -${100 + i}.00`);
}
