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
//     bun run scripts/pdf/try-render.ts [output-path]

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { renderPagePdf } from '@/lib/pdf/renderPagePdf';
import { log } from '@/lib/logger';

const DEMO_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const DEMO_USER_ID = 'aeb3949e-6c93-4c17-bbdf-b6d2d99fa9a2';

async function main() {
  const outPath = process.argv[2] ?? 'docs/superpowers/plans/screenshots/2026-09-ws-p-management-accounts.pdf';

  const pdf = await renderPagePdf({
    companyId: DEMO_COMPANY_ID,
    userId: DEMO_USER_ID,
    path: '/accounting/reports/management-accounts',
    apiPath: '/api/accounting/reports-management-accounts',
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, pdf);
  log.info('try-render: wrote PDF', { outPath, bytes: pdf.length }, 'pdf');
}

main().catch((err) => {
  log.error('try-render: failed', { message: err instanceof Error ? err.message : String(err) }, 'pdf');
  process.exitCode = 1;
});
