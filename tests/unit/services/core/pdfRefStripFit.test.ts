/**
 * A value in the PDF reference strip never runs past its column: "30 days from invoice date" in the last of five columns
 * crossed the strip's right border at the fixed 8pt (found by rendering a real PDF). The value shrinks until it fits.
 * Against a real jsPDF document: the width at the size actually drawn is measured against the width the code fits to
 * (column less 8mm), not a mocked number.
 */
import { describe, expect, it } from 'vitest';

describe('renderRefStrip fits each value to its column', () => {
  it('draws the longest terms line inside the last column at a size that fits, and short values at the full 8pt', async () => {
    const { jsPDF } = await import('jspdf');
    const { renderRefStrip } = await import('@/modules/accounting/services/core/pdfShared');
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const PAGE_W = doc.internal.pageSize.getWidth();
    const MARGIN = 14;
    const sizes = new Map<string, number>();
    const text = doc.text.bind(doc);
    (doc as unknown as { text: (t: string, x: number, y: number) => unknown }).text = (t: string, x: number, y: number) => {
      sizes.set(t, doc.getFontSize());
      return text(t, x, y);
    };
    const fields = ['Invoice #', 'Project', 'Issue Date', 'Due Date', 'Terms'].map((label, i) => ({
      label, value: i === 4 ? '999 days after statement' : i === 0 ? 'INV-1' : '05/12/2026',
    }));
    renderRefStrip(doc, 100, PAGE_W, MARGIN, fields);
    const colW = (PAGE_W - MARGIN * 2) / fields.length;
    doc.setFont('helvetica', 'bold');
    for (const f of fields) {
      doc.setFontSize(sizes.get(f.value)!);
      // The width the code fits to (colW - 8: 5mm in from the column edge, 3mm clear of the next), not the bare column.
      expect(doc.getTextWidth(f.value), f.value).toBeLessThanOrEqual(colW - 8);
    }
    expect(sizes.get('INV-1')).toBe(8);
    expect(sizes.get('999 days after statement')).toBeLessThan(8);
  });
});
