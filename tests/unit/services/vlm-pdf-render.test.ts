/**
 * The page render really produces a PNG on this box (Ghostscript, no temp
 * files). Before 2026-10-16 pdf2pic needed GraphicsMagick, which is not
 * installed, and an empty catch hid the failure on every PDF.
 */
import { describe, expect, it } from 'vitest';
import { renderPdfFirstPage } from '@/modules/accounting/services/bank/vlmPdfRender';

function onePagePdf(text: string, box = '0 0 612 792'): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('renderPdfFirstPage', () => {
  it('renders page 1 of a real PDF to a base64 PNG', async () => {
    const png = await renderPdfFirstPage(onePagePdf('TAX INVOICE 115.00'));
    expect(png).not.toBeNull();
    expect(Buffer.from(png!, 'base64').subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  }, 30_000);

  it('returns null (and does not throw) for bytes that are not a PDF', async () => {
    expect(await renderPdfFirstPage(Buffer.from('not a pdf'))).toBeNull();
    expect(await renderPdfFirstPage(Buffer.alloc(0))).toBeNull();
  }, 30_000);

  it('renders a hostile 14,400pt page into the same bounded frame', async () => {
    const png = Buffer.from((await renderPdfFirstPage(onePagePdf('HUGE', '0 0 14400 14400')))!, 'base64');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1275, 1754]);
  }, 30_000);

  it('renders only page 1 of a two-page PDF', async () => {
    const one = await renderPdfFirstPage(onePagePdf('PAGE ONE'));
    const pdf = onePagePdf('PAGE ONE').toString('latin1')
      .replace('/Kids [3 0 R] /Count 1', '/Kids [3 0 R 3 0 R] /Count 2');
    const png = await renderPdfFirstPage(Buffer.from(pdf, 'latin1'));
    expect(png).toBe(one);
  }, 30_000);
});
