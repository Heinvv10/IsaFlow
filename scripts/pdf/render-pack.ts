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

import { execFile } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { promisify } from 'util';
import { renderPagePdf } from '@/lib/pdf/renderPagePdf';
import { chooseTransportName } from '@/lib/pdf/selectTransport';
import { packPrintApiPaths } from '@/modules/accounting/services/packs/packSections';
import { buildBoardPackDocument } from '@/modules/accounting/services/packs/pages/boardPackDocument';
import { checkPackTextLayer } from '@/modules/accounting/services/packs/figures/packTextLayer';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';

const execFileAsync = promisify(execFile);

/**
 * THE ARTEFACT IS READ BACK BEFORE THE SCRIPT CALLS THE RENDER A SUCCESS.
 *
 * A twelve-sheet pack with no figures on it is a well-formed PDF of the right
 * length, and this script used to report exactly that as a win. So the bytes
 * go back through `pdftotext` and the text layer is checked against the
 * document the same figures compose — see `packTextLayer.ts` for what it
 * looks for and why.
 *
 * Board packs only: they are the one pack type composed as a page model, so
 * they are the only one whose expectations can be derived rather than guessed.
 */
async function verifyTextLayer(
  outPath: string,
  companyId: string,
  from: string,
  to: string,
): Promise<void> {
  const doc = await buildBoardPackDocument({
    companyId, from, to, preparedBy: 'render-pack', generatedAt: new Date().toISOString(),
  });
  // No `-layout`: see `checkPackTextLayer`.
  const { stdout } = await execFileAsync('pdftotext', [outPath, '-']);
  const failures = checkPackTextLayer(doc, stdout);
  if (failures.length === 0) return;
  throw new Error(
    `the rendered pack is missing ${failures.length} things it must print:\n${failures.join('\n')}`,
  );
}
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
  if (packType === 'board') await verifyTextLayer(outPath, companyId, from, to);
  log.info('render-pack: wrote PDF', {
    outPath, bytes: pdf.length, transport: chooseTransportName(process.env),
  }, 'pdf');
}

main().catch((err) => {
  log.error('render-pack: failed', { message: err instanceof Error ? err.message : String(err) }, 'pdf');
  process.exitCode = 1;
});
