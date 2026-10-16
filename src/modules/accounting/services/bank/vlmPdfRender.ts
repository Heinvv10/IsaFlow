/**
 * VLM PDF render — turns the first page of a PDF into a PNG for the VLM.
 *
 * vLLM rejects a PDF sent as `image_url` (400 "cannot identify image file"),
 * so a scanned PDF only reaches the model as a rendered page. The PDF is an
 * untrusted upload, so:
 * - gs only ever sees bytes starting `%PDF-` (anything before the header is cut
 *   off; gs runs a file that does not start `%PDF-` as PostScript);
 * - gs runs inside bubblewrap: no network, read-only /usr, a throwaway /tmp,
 *   none of the app's files, a clean environment. `-dSAFER` alone still lets it
 *   write under the temp dir. No bwrap → no render (fail closed);
 * - page 1 only, into a fixed-size frame, stdin → stdout, a hard timeout, an
 *   output cap. Output that is not a PNG (an encrypted PDF exits 0 with only a
 *   message) is a failure. Callers bound how many run at once.
 */

import { spawn } from 'child_process';
import { log } from '@/lib/logger';

const RENDER_TIMEOUT_MS = 30_000;
const MAX_PNG_BYTES = 20 * 1024 * 1024;
const PDF_MAGIC = '%PDF-';
/** Readers accept the header anywhere in the first 1 KB. */
const HEADER_SEARCH_BYTES = 1024;
const BWRAP = '/usr/bin/bwrap';
const SANDBOX_ARGS = [
  '--ro-bind', '/usr', '/usr',
  '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
  '--ro-bind-try', '/etc/ghostscript', '/etc/ghostscript', '--ro-bind-try', '/etc/fonts', '/etc/fonts',
  '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev',
  '--unshare-all', '--die-with-parent', '--new-session',
  '--clearenv', '--setenv', 'PATH', '/usr/bin', '--setenv', 'TMPDIR', '/tmp',
  '/usr/bin/gs',
];
const GS_ARGS = [
  '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dNOPROMPT',
  // A fixed 1754x1754 frame with the page scaled to fit, aspect kept: A4 reads
  // at 150 dpi portrait OR landscape, and a hostile 14,400pt page costs the
  // same memory as an A4 one.
  '-sDEVICE=png16m', '-g1754x1754', '-dFIXEDMEDIA', '-dPDFFitPage', '-dFirstPage=1', '-dLastPage=1',
  '-sOutputFile=-', '-',
];

/** Base64 PNG of page 1, or null when the PDF cannot be rendered (logged). */
export async function renderPdfFirstPage(pdfBuffer: Buffer): Promise<string | null> {
  const start = pdfBuffer.subarray(0, HEADER_SEARCH_BYTES).indexOf(PDF_MAGIC, 0, 'latin1');
  if (start < 0) {
    log.warn('Not rendered: no %PDF- header in the first 1 KB', { bytes: pdfBuffer.length }, 'vlm-pdf-render');
    return null;
  }
  try {
    const { png, stderr } = await runGhostscript(pdfBuffer.subarray(start));
    if (png.subarray(0, 4).toString('latin1') === '\x89PNG') {
      return png.toString('base64');
    }
    log.warn('PDF render produced no readable page', {
      bytes: pdfBuffer.length, pngBytes: png.length, stderr: stderr.trim(),
    }, 'vlm-pdf-render');
  } catch (err) {
    log.warn('PDF render failed', {
      bytes: pdfBuffer.length,
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-pdf-render');
  }
  return null;
}

function runGhostscript(pdfBuffer: Buffer): Promise<{ png: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const gs = spawn(BWRAP, [...SANDBOX_ARGS, ...GS_ARGS], { stdio: ['pipe', 'pipe', 'pipe'] });
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
      else if (code !== 0) reject(new Error(`gs (bwrap) exited ${code}: ${stderr.trim()}`));
      else resolve({ png: Buffer.concat(chunks), stderr });
    });
    gs.stdin.end(pdfBuffer);
  });
}
