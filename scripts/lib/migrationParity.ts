/**
 * Pure core of the pre-deploy migration-parity gate (no IO).
 *
 * PENDING = repo files not tracked on prod, i.e. what this deploy will apply.
 * Dev is only held to account for what matters to this deploy: the ~49 old
 * migrations hand-applied to dev without tracking rows are a known historical
 * gap and are counted, never failed.
 */

export interface ParityFile {
  name: string;
  version: string;
  checksum: string;
}

export interface ParityRow {
  name: string;
  checksum: string | null;
}

export type ParityRule = 'PROD_AHEAD' | 'PROD_CHECKSUM' | 'DEV_CHECKSUM' | 'DEV_MISSING';

export interface ParityFinding {
  rule: ParityRule;
  name: string;
  /** FAIL blocks the deploy; FIX is auto-applied to dev by --apply-dev. */
  severity: 'FAIL' | 'FIX';
  detail: string;
  fixes: string[];
}

export interface ParityResult {
  findings: ParityFinding[];
  /** Pending files absent from dev, in the runner's apply order. */
  devMissing: string[];
  /** Old files on prod but untracked on dev (the historical gap). */
  ignoredHistoric: number;
  /** Allowlisted historic prod rows with no repo file. */
  ignoredOrphans: number;
  ok: boolean;
}

/**
 * Prod tracking rows whose files were renamed or deleted from the repo long ago
 * (BL-95..BL-102 duplicate-prefix renames, 245_inventory.sql removal, etc.).
 * Measured against prod on 2026-10-09: exactly these 13 rows have no repo file.
 * The code is not behind prod's schema for them, so they must not trip
 * PROD_AHEAD. Any OTHER orphan row still fails; do not add to this list to
 * silence a real PROD_AHEAD.
 */
export const HISTORIC_PROD_ORPHANS: ReadonlySet<string> = new Set([
  '245_inventory.sql',
  '246_purchase_orders.sql',
  '250_vlm_extraction.sql',
  '251_projects.sql',
  '255_migration_wizard.sql',
  '265_vat_period_alignment.sql',
  '266_admin_platform_company_user_ext.sql',
  '292_product_categories_company_id.sql',
  '300_webhooks.sql',
  '347_auto_posting_foundation',
  '397_uif_declarations.sql',
  '431_waitlist_signups.sql',
  '462_bank_transfer_allocation.sql',
]);

const DIR = 'scripts/migrations/sql';
const short = (s: string | null): string => (s ?? 'null').slice(0, 8);

function byVersionThenName(a: ParityFile, b: ParityFile): number {
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function classifyMigrationParity(
  files: ParityFile[],
  devRows: ParityRow[],
  prodRows: ParityRow[],
  opts: { applyDev: boolean }
): ParityResult {
  const fileByName = new Map(files.map((f) => [f.name, f]));
  const dev = new Map(devRows.map((r) => [r.name, r]));
  const prod = new Map(prodRows.map((r) => [r.name, r]));
  const findings: ParityFinding[] = [];
  const devMissingFiles: ParityFile[] = [];
  let ignoredHistoric = 0;
  let ignoredOrphans = 0;

  for (const p of prodRows) {
    if (!fileByName.has(p.name) && HISTORIC_PROD_ORPHANS.has(p.name)) {
      ignoredOrphans += 1;
    } else if (!fileByName.has(p.name)) {
      findings.push({
        rule: 'PROD_AHEAD',
        name: p.name,
        severity: 'FAIL',
        detail: 'tracked on prod but absent from this branch (deploying would ship code behind prod\'s schema)',
        fixes: ['git merge origin/master   # the branch is behind: bring in the missing migration file'],
      });
    }
  }

  for (const f of [...files].sort(byVersionThenName)) {
    const onProd = prod.get(f.name);
    const onDev = dev.get(f.name);

    if (onProd && onProd.checksum !== null && onProd.checksum !== f.checksum) {
      findings.push({
        rule: 'PROD_CHECKSUM',
        name: f.name,
        severity: 'FAIL',
        detail: `file edited after prod applied it (file=${short(f.checksum)} prod=${short(onProd.checksum)}); apply-migrations would refuse`,
        fixes: [`git log -p -- ${DIR}/${f.name}   # restore the applied content; ship the change as a NEW migration`],
      });
    }

    if (onDev && onDev.checksum !== null && onDev.checksum !== f.checksum) {
      findings.push({
        rule: 'DEV_CHECKSUM',
        name: f.name,
        severity: 'FAIL',
        detail: `dev checksum differs from the repo file (file=${short(f.checksum)} dev=${short(onDev.checksum)}): edited in place, dev != master`,
        fixes: [
          `psql "$DEV_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f ${DIR}/${f.name}   # only if re-running is safe`,
          `psql "$DEV_DATABASE_URL" -c "UPDATE schema_migrations SET checksum = '${f.checksum}' WHERE name = '${f.name}'"`,
        ],
      });
    }

    if (!onProd && !onDev) devMissingFiles.push(f);
    if (onProd && !onDev) ignoredHistoric += 1;
  }

  const severity = opts.applyDev ? 'FIX' : 'FAIL';
  for (const f of devMissingFiles) {
    findings.push({
      rule: 'DEV_MISSING',
      name: f.name,
      severity,
      detail: 'pending for prod but not applied on dev',
      fixes: [
        `psql "$DEV_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f ${DIR}/${f.name}`,
        `psql "$DEV_DATABASE_URL" -c "INSERT INTO schema_migrations (version, name, checksum) VALUES ('${f.version}', '${f.name}', '${f.checksum}')"`,
      ],
    });
  }

  return {
    findings,
    devMissing: devMissingFiles.map((f) => f.name),
    ignoredHistoric,
    ignoredOrphans,
    ok: findings.every((x) => x.severity !== 'FAIL'),
  };
}
