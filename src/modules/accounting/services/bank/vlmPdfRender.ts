/**
 * VLM PDF render — turns the first page of a PDF into a PNG for the VLM.
 *
 * vLLM rejects a PDF sent as `image_url` (400 "cannot identify image file"),
 * so a scanned PDF only reaches the model as a rendered page. pdf2pic drives
 * GraphicsMagick by default; velo-server ships ImageMagick + Ghostscript, so
 * the converter is switched to ImageMagick.
 */

import { fromBuffer } from 'pdf2pic';
import { log } from '@/lib/logger';

const RENDER_OPTIONS = { density: 200, format: 'png', width: 1600, height: 2200 };

/** Base64 PNG of page 1, or null when the PDF cannot be rendered (logged). */
export async function renderPdfFirstPage(pdfBuffer: Buffer): Promise<string | null> {
  try {
    const converter = fromBuffer(pdfBuffer, RENDER_OPTIONS);
    converter.setGMClass(true);
    const page = await converter(1, { responseType: 'base64' });
    if (page.base64) return page.base64;
    log.warn('PDF render produced no image', { bytes: pdfBuffer.length }, 'vlm-pdf-render');
  } catch (err) {
    log.warn('PDF render failed', {
      bytes: pdfBuffer.length,
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-pdf-render');
  }
  return null;
}
