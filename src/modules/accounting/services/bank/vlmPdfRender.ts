/**
 * VLM PDF render — turns the first page of a PDF into a PNG for the VLM.
 *
 * vLLM rejects a PDF sent as `image_url` (400 "cannot identify image file"),
 * so a scanned PDF only reaches the model as a rendered page. The PDF is an
 * untrusted upload, so it goes to Ghostscript alone (no ImageMagick, no
 * shell): `-dSAFER`, page 1 only into a fixed-size frame, stdin → stdout (no
 * temp files), a hard timeout, and an output cap. Callers bound how many
 * renders run at once.
 */

import { spawn } from 'child_process';
import { log } from '@/lib/logger';

const RENDER_TIMEOUT_MS = 30_000;
const MAX_PNG_BYTES = 20 * 1024 * 1024;
const GS_ARGS = [
  '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dNOPROMPT',
  // A fixed 1275x1754 frame (A4 at 150 dpi) with the page scaled to fit, aspect
  // kept: a hostile 14,400pt page costs the same memory as an A4 one.
  '-sDEVICE=png16m', '-g1275x1754', '-dFIXEDMEDIA', '-dPDFFitPage', '-dFirstPage=1', '-dLastPage=1',
  '-sOutputFile=-', '-',
];

/** Base64 PNG of page 1, or null when the PDF cannot be rendered (logged). */
export async function renderPdfFirstPage(pdfBuffer: Buffer): Promise<string | null> {
  try {
    const png = await runGhostscript(pdfBuffer);
    if (png.subarray(0, 4).toString('latin1') === '\x89PNG') return png.toString('base64');
    log.warn('PDF render produced no image', { bytes: pdfBuffer.length }, 'vlm-pdf-render');
  } catch (err) {
    log.warn('PDF render failed', {
      bytes: pdfBuffer.length,
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-pdf-render');
  }
  return null;
}

function runGhostscript(pdfBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gs = spawn('gs', GS_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let failure: Error | null = null;

    const fail = (err: Error) => {
      if (!failure) failure = err;
      gs.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail(new Error(`gs timed out after ${RENDER_TIMEOUT_MS} ms`)), RENDER_TIMEOUT_MS);

    gs.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PNG_BYTES) fail(new Error(`gs output exceeded ${MAX_PNG_BYTES} bytes`));
      else chunks.push(chunk);
    });
    gs.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-500); });
    // gs may exit before reading all of a corrupt input; that EPIPE is not the failure.
    gs.stdin.on('error', (err) => log.debug('gs stdin closed early', { error: err.message }, 'vlm-pdf-render'));
    gs.on('error', fail);
    gs.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`gs exited ${code}: ${stderr.trim()}`));
      else resolve(Buffer.concat(chunks));
    });
    gs.stdin.end(pdfBuffer);
  });
}
