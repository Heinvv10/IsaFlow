/**
 * A weak VLM read of a PDF does not shadow a better regex read of its text.
 * Before 2026-10-16 the VLM PDF path always failed, so `extractFromPdf` fell
 * through to the regex reader; now the VLM can return a low-confidence read,
 * and `extractFromPdf` keeps whichever of the two scores higher.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const vlm = vi.hoisted(() => ({ result: null as Partial<ExtractedDocument> | null }));
vi.mock('@/modules/accounting/services/bank/vlmService', () => ({
  isVlmAvailable: () => true,
  extractWithVlm: vi.fn(),
  extractPdfWithVlm: vi.fn(async () => (vlm.result ? { warnings: [], ...vlm.result } : null)),
}));

import { extractFromPdf, extractFromText } from '@/modules/accounting/services/core/ocrService';

const LINES = ['Acme Supplies (Pty) Ltd', 'TAX INVOICE', 'Invoice No: INV-1001', 'Date: 2026-09-01',
  'Subtotal 100.00', 'VAT 15.00', 'Total 115.00'];

function textPdf(lines: string[]): Buffer {
  const body = lines.map((l, i) => `BT /F1 12 Tf 72 ${720 - i * 18} Td (${l}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
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

describe('extractFromPdf picks the better of a weak VLM read and the regex read', () => {
  it('keeps the regex read when the VLM read scores lower', async () => {
    vlm.result = { extractionMethod: 'vlm', confidence: 0.1, vendorName: null };
    const doc = await extractFromPdf(textPdf(LINES));
    expect(doc.extractionMethod).toBe('regex');
    expect(doc.confidence).toBeGreaterThan(0.1);
  });

  it('keeps the weak VLM read when the regex read scores lower still', async () => {
    const sparse = ['Thank you for your business', 'Please call us'];
    expect((await extractFromText(sparse.join('\n'))).confidence).toBeLessThan(0.55);
    vlm.result = { extractionMethod: 'vlm', confidence: 0.55 };
    const doc = await extractFromPdf(textPdf(sparse));
    expect(doc.extractionMethod).toBe('vlm');
  });

  it('returns a confident VLM read without consulting the regex', async () => {
    vlm.result = { extractionMethod: 'vlm', confidence: 0.6 };
    expect((await extractFromPdf(textPdf(LINES))).extractionMethod).toBe('vlm');
  });
});
