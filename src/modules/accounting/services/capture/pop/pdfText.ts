/** The text layer of a PDF (pdf-parse v2, as ocrService.ts reads it); null when it cannot be read. */
import { log } from '@/lib/logger';

export async function pdfText(content: Buffer): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFParse } = require('pdf-parse') as {
      PDFParse: new (opts: { data: Buffer }) => { getText(): Promise<{ text: string }> };
    };
    return (await new PDFParse({ data: content }).getText()).text ?? '';
  } catch (err) {
    log.warn('POP PDF text could not be read', { err: err instanceof Error ? err.message : String(err) }, 'pop-inbox');
    return null;
  }
}
