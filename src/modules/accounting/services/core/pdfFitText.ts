/** Fitting text to a PDF column. Split from pdfShared (already over the file-size ceiling). */
import type { JsPdfDoc } from './pdfShared';

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
