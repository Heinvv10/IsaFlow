/**
 * What an unsaved invoice's preview PDF prints beyond the invoice (master plan wave 4, PR PV): the "PREVIEW: NOT
 * SAVED" mark in the number's place and across every page, and the preview's own notes (a job not recognised).
 * Kept apart from invoicePdfBuilder.ts, which is near its size.
 */
import { COLORS, type JsPdfDoc } from '../core/pdfShared';

export const PREVIEW_WATERMARK = 'PREVIEW: NOT SAVED';

/** Passed to generateInvoicePdf for an unsaved invoice. */
export interface InvoicePdfPreviewOptions { notes: readonly string[] }

/** The preview's notes under the line items, in red; returns the next y. */
export function renderPreviewNotes(doc: JsPdfDoc, y: number, margin: number, notes: readonly string[]): number {
  if (notes.length === 0) return y;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...COLORS.DANGER);
  for (const note of notes) { doc.text(note, margin, y); y += 4; }
  doc.setTextColor(...COLORS.TEXT_PRIMARY);
  return y + 2;
}

/** The mark across the middle of every page, drawn last so no page is without it. */
export function renderPreviewWatermark(doc: JsPdfDoc, pageW: number, pageH: number): void {
  const pages = (doc as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(44);
    doc.setTextColor(...COLORS.TEXT_MUTED);
    doc.text(PREVIEW_WATERMARK, pageW / 2, pageH / 2, { align: 'center', angle: 35 });
  }
  doc.setTextColor(...COLORS.TEXT_PRIMARY);
}
