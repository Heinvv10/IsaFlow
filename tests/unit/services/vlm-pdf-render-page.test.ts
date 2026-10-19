/**
 * A statement is read page by page, so the render takes the page number. Real
 * Ghostscript on a two-page PDF whose pages differ: page 2 must be page 2, not
 * page 1, and a page the PDF does not have must be a failure, not page 1.
 */
import { describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({ argv: [] as string[][] }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: ((cmd: string, args: string[], opts: object) => {
      sent.argv.push([cmd, ...args]);
      return actual.spawn(cmd, args, opts);
    }) as typeof actual.spawn,
  };
});

import { renderPdfFirstPage, renderPdfPage } from '@/modules/accounting/services/bank/vlmPdfRender';

function twoPagePdf(): Buffer {
  const text = (t: string) => `BT /F1 40 Tf 72 400 Td (${t}) Tj ET`;
  const streams = [text('PAGE ONE ONE ONE'), text('PAGE TWO')];
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`,
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

describe('renderPdfPage', () => {
  it('renders the requested page, not page 1', async () => {
    const pdf = twoPagePdf();
    const one = await renderPdfPage(pdf, 1);
    const two = await renderPdfPage(pdf, 2);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(two).not.toBe(one);
    // One PNG, not pages 1..2 laid end to end.
    expect(Buffer.from(two!, 'base64').toString('latin1').split('IHDR')).toHaveLength(2);
  }, 30_000);

  it('asks gs for exactly that page and no other', async () => {
    sent.argv.length = 0;
    await renderPdfPage(twoPagePdf(), 2);
    expect(sent.argv[0]).toContain('-dFirstPage=2');
    expect(sent.argv[0]).toContain('-dLastPage=2');
    expect(sent.argv[0]).not.toContain('-dFirstPage=1');
  }, 30_000);

  it('returns null for a page the PDF does not have', async () => {
    expect(await renderPdfPage(twoPagePdf(), 3)).toBeNull();
  }, 30_000);

  it('rejects a page number that is not a positive integer without spawning gs', async () => {
    sent.argv.length = 0;
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(await renderPdfPage(twoPagePdf(), bad)).toBeNull();
    }
    expect(sent.argv).toHaveLength(0);
  }, 30_000);

  it('renderPdfFirstPage is page 1', async () => {
    const pdf = twoPagePdf();
    expect(await renderPdfFirstPage(pdf)).toBe(await renderPdfPage(pdf, 1));
  }, 30_000);
});
