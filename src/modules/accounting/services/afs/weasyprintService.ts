/**
 * WeasyPrint Docker sidecar — thin HTTP wrapper.
 *
 * Setup on velo:
 *   docker run -d \
 *     --name weasyprint \
 *     --restart unless-stopped \
 *     -p 5001:5001 \
 *     ghcr.io/funkyfuture/weasyprint:latest
 *
 * Set WEASYPRINT_URL=http://weasyprint:5001 in .env.local (dev)
 * and in the systemd service environment for production.
 *
 * Verify: curl -X POST http://localhost:5001/pdf \
 *   -H 'Content-Type: application/json' \
 *   -d '{"html":"<h1>Test</h1>"}' --output test.pdf
 */

import { log } from '@/lib/logger';

export interface WeasyprintOptions {
  pdfVariant?: 'pdf/a-3u';
}

export async function htmlToPdf(
  html: string,
  options?: WeasyprintOptions
): Promise<Buffer> {
  const url = process.env.WEASYPRINT_URL;
  if (!url) throw new Error('WEASYPRINT_URL environment variable is not set');

  log.info('Calling WeasyPrint sidecar', { htmlLength: html.length }, 'weasyprintService');

  const response = await fetch(`${url}/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, options }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log.error('WeasyPrint error', { status: response.status, body }, 'weasyprintService');
    throw new Error(`WeasyPrint error: ${response.status} ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  log.info('WeasyPrint PDF generated', { bytes: arrayBuffer.byteLength }, 'weasyprintService');
  return Buffer.from(arrayBuffer);
}
