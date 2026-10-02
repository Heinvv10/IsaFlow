/**
 * The identifiers a pack's pages carry OUTSIDE the page box: the running
 * footer Chromium draws in the bottom margin, and the PDF's Info dictionary.
 *
 * IT LIVES HERE, ONCE, BECAUSE TWO CALLERS DERIVING IT SEPARATELY IS HOW THE
 * EVIDENCE STOPPED MATCHING THE PRODUCT. `pdf.ts` built the furniture inline;
 * `scripts/pdf/render-pack.ts` — the script every clean-room render in
 * `evidence/` is produced with — called `renderPagePdf` with no `footerHtml`
 * and no `metadata` at all. The renders therefore printed Chromium's bare
 * `n / m` default and carried `Creator: Chromium`, and a reviewer reading
 * those sheets correctly reported that a director holding a loose sheet 7
 * cannot tell which company or which period it belongs to. The route was
 * never broken; the proof of it was.
 *
 * The identifiers belong in the footer and NOT in the page header: the title
 * hierarchy leads with the page's conclusion, and re-inflating the header to
 * repeat the company name would cost every content sheet two lines of a box
 * several pages already sit within a millimetre of.
 */
import { sql, type DbRow } from '@/lib/neon';
import { PACK_CONFIDENTIALITY, type PackFurniture } from '@/lib/pdf/printFurniture';
import { PACK_LABELS } from '@/modules/accounting/services/packs/packSections';
import type { PackType } from '@/modules/accounting/services/reports/reportPackService';
import { formatPackPeriod } from './packPeriodLabel';
import { readPackDraftState } from './packDraftState';

export type { PackFurniture };

/**
 * THE SAME ANSWER THE PAGES READ, not a second derivation of it. `draft` is
 * `readPackDraftState`, which is one of the two reasons a pack is a draft:
 * Brightsphere's period IS closed and its commentary is NOT approved, so its
 * cover says DRAFT and every sheet carries the watermark. A status that
 * reaches some surfaces and not others is the whole defect — the footer
 * travels with a forwarded page and the metadata is what a document system
 * indexes. See `packDraftState.ts`.
 */
export async function buildPackFurniture(
  companyId: string,
  packType: PackType,
  from: string,
  to: string,
): Promise<PackFurniture> {
  const rows = (await sql`SELECT name FROM companies WHERE id = ${companyId}::uuid LIMIT 1`) as DbRow[];
  const draftState = await readPackDraftState(companyId, packType, from, to);
  return {
    companyName: rows[0]?.name ? String(rows[0].name) : '',
    packLabel: PACK_LABELS[packType],
    period: formatPackPeriod(from, to),
    confidentiality: PACK_CONFIDENTIALITY,
    draft: draftState.reasons.length > 0,
  };
}
