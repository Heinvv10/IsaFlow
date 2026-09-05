// scripts/pdf/render-pack.ts
//
// Renders a report pack end to end and writes the artefact to disk. Task 12
// proof script — exercises the same renderPagePdf path the download route
// uses, against a real tenant, through whichever transport PDF_TRANSPORT /
// GOTENBERG_URL selects (see src/lib/pdf/selectTransport.ts).
//
// Requires:
//   - the dev server running and reachable at APP_URL
//   - PRINT_TOKEN_SECRET set to the same value the dev server was started with
//   - GOTENBERG_URL set to exercise the Gotenberg transport; unset for Playwright
//
// PDF_COMPANY_ID / PDF_USER_ID override the demo tenant (e.g. to render
// against Brightsphere instead of the ISAFlow Demo shell).
//
// Usage:
//   APP_URL=http://localhost:3200 PRINT_TOKEN_SECRET=<secret> \
//     bun run scripts/pdf/render-pack.ts management 2026-01-01 2026-09-05 out.pdf

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { renderPagePdf } from '@/lib/pdf/renderPagePdf';
import { chooseTransportName } from '@/lib/pdf/selectTransport';
import { packPrintApiPaths } from '@/modules/accounting/services/packs/packSections';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';
import { log } from '@/lib/logger';

const DEMO_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const DEMO_USER_ID = 'aeb3949e-6c93-4c17-bbdf-b6d2d99fa9a2';

async function main() {
  const packType = (process.argv[2] ?? 'management') as PackType;
  const from = process.argv[3] ?? '2026-01-01';
  const to = process.argv[4] ?? '2026-09-05';
  const outPath = process.argv[5] ?? `docs/superpowers/plans/screenshots/2026-09-ws2-${packType}-pack.pdf`;
  const companyId = process.env.PDF_COMPANY_ID ?? DEMO_COMPANY_ID;
  const userId = process.env.PDF_USER_ID ?? DEMO_USER_ID;

  const pdf = await renderPagePdf({
    companyId,
    userId,
    path: '/accounting/reports/report-packs',
    query: { pack: packType, from, to },
    apiPaths: packPrintApiPaths(packType),
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, pdf);
  log.info('render-pack: wrote PDF', {
    outPath, bytes: pdf.length, transport: chooseTransportName(process.env),
  }, 'pdf');
}

main().catch((err) => {
  log.error('render-pack: failed', { message: err instanceof Error ? err.message : String(err) }, 'pdf');
  process.exitCode = 1;
});
