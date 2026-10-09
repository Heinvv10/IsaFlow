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

export type ParityRule =
  | 'PROD_AHEAD'
  | 'PROD_CHECKSUM'
  | 'DEV_CHECKSUM'
  | 'DEV_MISSING'
  | 'DEV_MISSING_APPLIED_ON_PROD'
  | 'DUPLICATE_PENDING_VERSION'
  | 'PENDING_VERSION_TAKEN';

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
  /** Allowlisted old files on prod but untracked on dev (the historical gap). */
  ignoredHistoric: number;
  ignoredNames: string[];
  /** Prod rows with a NULL checksum (legacy): never a mismatch, so surfaced as a count. */
  prodNullChecksums: number;
  /** Allowlisted historic prod rows with no repo file. */
  ignoredOrphans: number;
  ok: boolean;
}

/**
 * Prod tracking rows whose files were renamed or deleted from the repo long ago
 * (BL-95..BL-102 duplicate-prefix renames, 245_inventory.sql removal, etc.).
 * Measured against prod on 2026-10-09: exactly these 13 rows have no repo file.
 * Provenance: 245 was deleted in 86ec9663e; 246/250/251/255/265/266/292/300 were
 * renamed in 3e801d749; 431 was renamed. `git log --all --diff-filter=D` finds
 * NO history at all for 397_uif_declarations.sql or 462_bank_transfer_allocation.sql
 * (no repo file under that name was ever committed; 462 has no successor - the
 * neighbours are 460/461/463/464). Those two prod rows are unexplained; a fresh
 * database built from the repo will not have whatever schema they added, if any.
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

/**
 * Repo files tracked on prod but NOT on dev: the schema was hand-applied to
 * dev without tracking rows (some backfills cannot run there). Frozen to the 45
 * names measured read-only on 2026-10-09. Any other prod-but-not-dev file is a
 * real gap (DEV_MISSING_APPLIED_ON_PROD). Do not extend to silence a failure.
 */
export const HISTORIC_DEV_UNTRACKED: ReadonlySet<string> = new Set([
  '524_redate_remaining_batch_dated_journals.sql',
  '525_dedupe_system_account_subtypes.sql',
  '526_gl_je_source_record_id.sql',
  '527_practice_taxonomy_unique_names.sql',
  '528_credit_note_cancellation_columns.sql',
  '529_credit_note_applied_amount.sql',
  '530_external_ref_and_actor_identity.sql',
  '531_credit_note_actor_and_lock_notes.sql',
  '532_company_relationships_audit.sql',
  '533_afs_statement_line_totals.sql',
  '535_credit_note_invoice_indexes.sql',
  '540_payment_method_contra.sql',
  '570_vat_period_locks.sql',
  '580_document_link_lookup_index.sql',
  '581_acting_company_on_writes.sql',
  '605_seed_missing_system_account_roles.sql',
  '606_backfill_system_account_roles.sql',
  '607_fix_near_miss_system_account_roles.sql',
  '608_backfill_income_statement_subtypes.sql',
  '609_seed_chart_income_statement_header_subtypes.sql',
  '615_ap_payment_document_backfill.sql',
  '616_capture_email_address_identity.sql',
  '617_capture_whatsapp_destination_identity.sql',
  '618_capture_whatsapp_provider_proof.sql',
  '619_gl_journal_entry_single_reversal.sql',
  '620_customer_payments_card_reference_unique.sql',
  '623_gl_je_reversal_of_index.sql',
  '624_subscription_charges_subscription_id.sql',
  '625_supplier_invoice_duplicate_fingerprint_lookup.sql',
  '627_gl_je_source_year_end.sql',
  '644_loan_gl_postings_period_once.sql',
  '645_loan_reclass_postings.sql',
  '646_supplier_invoice_number_unique.sql',
  '647_approval_rules_condition_operator_check.sql',
  '648_invite_company_name_security_definer.sql',
  '649_cost_centre_delete_restrict.sql',
  '659_loan_reclass_postings_backfill_rebuild.sql',
  '660_cost_centre_parent_delete_restrict.sql',
  '662_invite_token_encoding_retire_stale.sql',
  '663_invite_company_name_definer_hardening.sql',
  '664_gl_journal_lines_account_company_fk.sql',
  '666_customer_quote_number_unique.sql',
  '692_invoice_total_non_negative_guard.sql',
  '694_sage_customer_invoice_link.sql',
  '719_bank_reconciliation_reopen.sql',
]);

/** True when a migration issues its own COMMIT, so a failure after it cannot be rolled back atomically. */
export function hasOwnCommit(sql: string): boolean {
  const stripped = sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '') // function / DO bodies cannot end the outer transaction
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
  return /(^|;)\s*(COMMIT|END)(\s+(WORK|TRANSACTION))?(\s+AND\s+(NO\s+)?CHAIN)?\s*(;|$)/i.test(stripped);
}

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
  const ignoredNames: string[] = [];
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
          `psql "$DEV_DATABASE_URL" -c "UPDATE schema_migrations SET checksum = '${f.checksum}' WHERE name = '${f.name}'"   # last resort: only records the new hash, does not change dev's schema`,
        ],
      });
    }

    if (!onProd && !onDev) devMissingFiles.push(f);
    if (onProd && !onDev) {
      if (HISTORIC_DEV_UNTRACKED.has(f.name)) {
        ignoredNames.push(f.name);
      } else {
        findings.push({
          rule: 'DEV_MISSING_APPLIED_ON_PROD',
          name: f.name,
          severity: 'FAIL',
          detail: 'already on prod but not tracked on dev (not in the frozen historic list); a human must apply it on dev',
          fixes: [
            `psql "$DEV_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f ${DIR}/${f.name}`,
            `psql "$DEV_DATABASE_URL" -c "INSERT INTO schema_migrations (version, name, checksum) VALUES ('${f.version}', '${f.name}', '${f.checksum}')"`,
          ],
        });
      }
    }
  }

  const pendingByVersion = new Map<string, ParityFile[]>();
  for (const f of files) {
    if (prod.has(f.name)) continue;
    pendingByVersion.set(f.version, [...(pendingByVersion.get(f.version) ?? []), f]);
  }
  for (const group of pendingByVersion.values()) {
    if (group.length < 2) continue;
    for (const f of group) {
      findings.push({
        rule: 'DUPLICATE_PENDING_VERSION',
        name: f.name,
        severity: 'FAIL',
        detail: `version prefix ${f.version} is shared by ${group.length} pending files; rename to the next unused prefix`,
        fixes: [`git mv ${DIR}/${f.name} ${DIR}/<next unused prefix>_<name>.sql`],
      });
    }
  }

  const prodVersions = new Set(prodRows.map((r) => /^(\d+[a-z]?)_/.exec(r.name)?.[1]).filter((v): v is string => !!v));
  for (const f of files) {
    if (prod.has(f.name) || !prodVersions.has(f.version)) continue;
    findings.push({
      rule: 'PENDING_VERSION_TAKEN',
      name: f.name,
      severity: 'FAIL',
      detail: `version prefix ${f.version} is already used by a migration tracked on prod (two branches claimed one prefix); rename to the next unused prefix`,
      fixes: [`git mv ${DIR}/${f.name} ${DIR}/<next unused prefix>_<name>.sql`],
    });
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
    ignoredHistoric: ignoredNames.length,
    ignoredNames,
    prodNullChecksums: prodRows.filter((r) => r.checksum === null).length,
    ignoredOrphans,
    ok: findings.every((x) => x.severity !== 'FAIL'),
  };
}
