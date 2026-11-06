/**
 * The columns of the PDF reference strip (pdfShared.renderRefStrip draws its box): a small label over a bold value, the
 * value shrunk until it fits its column. Split from pdfShared, which is already over the file-size ceiling.
 */
import type { COLORS, JsPdfDoc } from './pdfShared';

/** The largest font size from `max` down to `min` at which `text` (in the doc's current bold face) fits `maxWidth`; `min` when none does. */
export function fitFontSize(doc: JsPdfDoc, text: string, maxWidth: number, max: number, min: number): number {
  let size = max;
  doc.setFontSize(size);
  while (size > min && doc.getTextWidth(text) > maxWidth) {
    size -= 0.25;
    doc.setFontSize(size);
  }
  return size;
}

/** One column per field: 5mm in from the column's left edge, the value fitted to the column less 8mm (3mm clear of the next). */
export function drawRefStripFields(
  doc: JsPdfDoc, fields: { label: string; value: string }[], margin: number, y: number, colW: number, colors: typeof COLORS,
): void {
  fields.forEach((field, i) => {
    const cx = margin + colW * i + 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(...colors.TEXT_MUTED);
    doc.text(field.label.toUpperCase(), cx, y + 5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(fitFontSize(doc, field.value, colW - 8, 8, 6));
    doc.setTextColor(...colors.TEXT_PRIMARY);
    doc.text(field.value, cx, y + 11);
  });
}
