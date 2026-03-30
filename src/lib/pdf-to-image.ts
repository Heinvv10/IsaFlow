/**
 * Server-side utility: convert a PDF data URL to a PNG data URL.
 * Uses pdftoppm (poppler-utils) to render only the first page at 300 DPI.
 * Safe to call from any Next.js API route — never import this on the client.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { log } from '@/lib/logger';

const execFile = promisify(execFileCb);

const PDFTOPPM_BIN = '/usr/bin/pdftoppm';
const TMP_DIR      = '/tmp';

/**
 * Convert the first page of a PDF (supplied as a base64 data URL) to a PNG
 * base64 data URL suitable for passing to the Qwen3 VLM.
 *
 * @throws if pdftoppm fails or the output file is not produced
 */
export async function pdfToImage(pdfDataUrl: string): Promise<string> {
  // Strip the data URL header and decode to raw bytes
  const base64Content = pdfDataUrl.replace(/^data:application\/pdf;base64,/, '');
  const pdfBuffer     = Buffer.from(base64Content, 'base64');

  const id        = crypto.randomUUID();
  const inputPath = path.join(TMP_DIR, `isaflow-pdf-${id}.pdf`);
  // pdftoppm appends ".png" to the stem, producing <stem>.png
  const outputStem = path.join(TMP_DIR, `isaflow-pdf-${id}-out`);
  const outputPath = `${outputStem}.png`;

  log.info('PDF to image conversion starting', { id }, 'pdf-to-image');

  try {
    await fs.writeFile(inputPath, pdfBuffer);

    // Convert first page only at 300 DPI, single-file output
    await execFile(PDFTOPPM_BIN, [
      '-png',
      '-f', '1',
      '-l', '1',
      '-r', '300',
      '-singlefile',
      inputPath,
      outputStem,
    ]);

    // Verify output file was created
    try {
      await fs.access(outputPath);
    } catch {
      throw new Error(`pdftoppm did not produce output file: ${outputPath}`);
    }

    const pngBuffer = await fs.readFile(outputPath);
    const pngBase64 = pngBuffer.toString('base64');

    log.info('PDF to image conversion complete', { id, bytes: pngBuffer.length }, 'pdf-to-image');

    return `data:image/png;base64,${pngBase64}`;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('PDF to image conversion failed', { id, message }, 'pdf-to-image');
    throw new Error(`Failed to convert PDF to image: ${message}`);
  } finally {
    // Always clean up temp files — ignore errors during cleanup
    await fs.unlink(inputPath).catch(() => undefined);
    await fs.unlink(outputPath).catch(() => undefined);
  }
}
