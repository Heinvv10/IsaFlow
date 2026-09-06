// scripts/pdf/try-render.ts
//
// One-off proof script for the PDF pipeline (src/lib/pdf/renderPagePdf.ts):
// renders the management accounts report for the demo company and writes
// the PDF to disk. Requires:
//   - the dev server running and reachable at APP_URL
//   - PRINT_TOKEN_SECRET set to the same value the dev server was started with
//
// Usage:
//   APP_URL=http://localhost:3212 PRINT_TOKEN_SECRET=<secret> \
//     bun run scripts/pdf/try-render.ts [management-accounts|pack] [output-path]
//
// PDF_COMPANY_ID / PDF_USER_ID override the demo tenant.

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { renderPagePdf, type RenderPagePdfOptions } from '@/lib/pdf/renderPagePdf';
import { packPrintApiPaths } from '@/modules/accounting/services/packs/packSections';
import { log } from '@/lib/logger';

const DEMO_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const DEMO_USER_ID = 'aeb3949e-6c93-4c17-bbdf-b6d2d99fa9a2';

/** `pack` renders the printed report pack; anything else renders the
 *  management accounts page the script was originally written for. The pack's
 *  authorised paths come from `packPrintApiPaths`, never a second hand-written
 *  list — that list and the page's own fetches must stay one list. */
function targetFor(target: string, companyId: string, userId: string): RenderPagePdfOptions {
  if (target === 'pack') {
    return {
      companyId,
      userId,
      path: '/accounting/reports/report-packs',
      query: { pack: 'management', from: '2026-03-01', to: '2026-08-31' },
      apiPaths: packPrintApiPaths('management'),
    };
  }
  return {
    companyId,
    userId,
    path: '/accounting/reports/management-accounts',
    apiPaths: ['/api/accounting/reports-management-accounts'],
  };
}

async function main() {
  const target = process.argv[2] ?? 'management-accounts';
  const outPath = process.argv[3] ?? 'docs/superpowers/plans/screenshots/2026-09-ws-p-management-accounts.pdf';
  const companyId = process.env.PDF_COMPANY_ID ?? DEMO_COMPANY_ID;
  const userId = process.env.PDF_USER_ID ?? DEMO_USER_ID;

  const pdf = await renderPagePdf(targetFor(target, companyId, userId));

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, pdf);
  log.info('try-render: wrote PDF', { outPath, bytes: pdf.length }, 'pdf');
}

main().catch((err) => {
  log.error('try-render: failed', { message: err instanceof Error ? err.message : String(err) }, 'pdf');
  process.exitCode = 1;
});
