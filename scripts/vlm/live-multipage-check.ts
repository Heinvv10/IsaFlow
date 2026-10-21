/**
 * Live-model check, run by hand (never in CI): reads the synthetic scanned
 * invoice (tests/helpers/scanInvoicePdf — cover page, invoice on page 2, terms)
 * through the real capture path against the vLLM in VLLM_BASE_URL, and checks
 * the figures came from page 2. The vLLM is the live production model: run it
 * after hours only (17:00-08:00 SAST).
 *
 *   env $(grep -E '^(VLLM_|VLM_)' .env.local | xargs) bun scripts/vlm/live-multipage-check.ts [out-dir]
 *
 * With an out-dir it also writes the 3- and 5-page fixtures there (for a browser upload).
 */
import { writeFileSync } from 'fs';
import { extractFromPdf } from '@/modules/accounting/services/core/ocrService';
import { buildScanInvoicePdf, INVOICE } from '../../tests/helpers/scanInvoicePdf';

async function main(): Promise<void> {
  const outDir = process.argv[2];
  let failed = false;
  for (const pages of [3, 5]) {
    const pdf = buildScanInvoicePdf(pages);
    if (outDir) writeFileSync(`${outDir}/scan-invoice-${pages}p.pdf`, pdf);
    const started = Date.now();
    const doc = await extractFromPdf(pdf);
    const secs = (Date.now() - started) / 1000;
    const got = {
      vendorName: doc.vendorName, referenceNumber: doc.referenceNumber, date: doc.date,
      subtotal: doc.subtotal, vatAmount: doc.vatAmount, totalAmount: doc.totalAmount,
    };
    const ok = doc.totalAmount === INVOICE.totalAmount && doc.vatAmount === INVOICE.vatAmount
      && doc.subtotal === INVOICE.subtotal && doc.referenceNumber === INVOICE.referenceNumber
      && doc.date === INVOICE.date;
    failed ||= !ok;
    process.stdout.write(`${pages}-page scan: ${ok ? 'PASS' : 'FAIL'} in ${secs.toFixed(1)} s (${doc.extractionMethod})\n`
      + `  read:     ${JSON.stringify(got)}\n  expected: ${JSON.stringify(INVOICE)}\n`
      + `  warnings: ${JSON.stringify(doc.warnings)}\n`);
  }
  process.exit(failed ? 1 : 0);
}

void main();
