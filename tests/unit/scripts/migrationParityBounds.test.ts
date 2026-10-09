import { describe, it, expect } from 'vitest';
import {
  classifyMigrationParity,
  hasOwnCommit,
  HISTORIC_PROD_ORPHANS,
  HISTORIC_DEV_UNTRACKED,
  type ParityFile,
  type ParityRow,
} from '../../../scripts/lib/migrationParity';

const file = (name: string): ParityFile => ({ name, version: /^(\d+[a-z]?)_/.exec(name)![1]!, checksum: `sum-${name}` });
const row = (f: ParityFile): ParityRow => ({ name: f.name, checksum: f.checksum });
const run = (files: ParityFile[], dev: ParityRow[], prod: ParityRow[], applyDev = false) =>
  classifyMigrationParity(files, dev, prod, { applyDev });

// The 13 names, written out literally: swapping one in the source must turn this red.
const ORPHANS = [
  '245_inventory.sql', '246_purchase_orders.sql', '250_vlm_extraction.sql', '251_projects.sql',
  '255_migration_wizard.sql', '265_vat_period_alignment.sql', '266_admin_platform_company_user_ext.sql',
  '292_product_categories_company_id.sql', '300_webhooks.sql', '347_auto_posting_foundation',
  '397_uif_declarations.sql', '431_waitlist_signups.sql', '462_bank_transfer_allocation.sql',
];

describe('HISTORIC_PROD_ORPHANS is exactly the pinned 13', () => {
  it('matches the literal list', () => {
    expect([...HISTORIC_PROD_ORPHANS].sort()).toEqual([...ORPHANS].sort());
  });

  it.each(ORPHANS.flatMap((n) => [n.toUpperCase(), `${n}.bak`, `${n} `, `x${n}`, n.replace(/(\.sql)?$/, '2$1')]))(
    'near-miss %j still fails PROD_AHEAD',
    (name) => {
      if (HISTORIC_PROD_ORPHANS.has(name)) return; // 347_... upper/suffix variants never collide
      const r = run([], [], [{ name, checksum: 'x' }]);
      expect(r.findings.map((f) => f.rule)).toEqual(['PROD_AHEAD']);
    }
  );
});

// The 45 names measured read-only on dev vs prod on 2026-10-09, written out literally.
const DEV_UNTRACKED = [
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
];

describe('HISTORIC_DEV_UNTRACKED is a bounded, pinned list', () => {
  it('is exactly the 45 pinned names', () => {
    expect(DEV_UNTRACKED).toHaveLength(45);
    expect([...HISTORIC_DEV_UNTRACKED].sort()).toEqual([...DEV_UNTRACKED].sort());
  });

  it('ignores a listed name and reports it', () => {
    const f = file('719_bank_reconciliation_reopen.sql');
    const r = run([f], [], [row(f)]);
    expect(r.findings).toEqual([]);
    expect(r.ignoredHistoric).toBe(1);
    expect(r.ignoredNames).toEqual([f.name]);
  });

  it('any other prod-but-not-dev file fails DEV_MISSING_APPLIED_ON_PROD, even with applyDev, and is never auto-applied', () => {
    const f = file('870_new_on_prod.sql');
    const r = run([f], [], [row(f)], true);
    expect(r.findings.map((x) => `${x.rule}:${x.severity}`)).toEqual(['DEV_MISSING_APPLIED_ON_PROD:FAIL']);
    expect(r.devMissing).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.fixes.join('\n')).toContain('psql');
  });

  it('near-miss of a listed name is not ignored', () => {
    const f = file('719_bank_reconciliation_reopen.sql.bak');
    const r = classifyMigrationParity([{ ...f, version: '719' }], [], [row(f)], { applyDev: false });
    expect(r.ok).toBe(false);
  });
});

describe('duplicate pending version prefixes', () => {
  it('fails before any dev write', () => {
    const r = run([file('880_a.sql'), file('880_b.sql')], [], [], true);
    expect(r.findings.filter((f) => f.rule === 'DUPLICATE_PENDING_VERSION').map((f) => f.name)).toEqual(['880_a.sql', '880_b.sql']);
    expect(r.ok).toBe(false);
  });

  it('does not flag duplicate prefixes that are already on prod', () => {
    const a = file('245_a.sql');
    const b = file('245_b.sql');
    const r = run([a, b], [row(a), row(b)], [row(a), row(b)]);
    expect(r.findings).toEqual([]);
  });
});

describe('null-checksum prod rows', () => {
  it('are counted', () => {
    const a = file('870_a.sql');
    const r = run([a], [row(a)], [{ name: a.name, checksum: null }]);
    expect(r.prodNullChecksums).toBe(1);
  });
});

describe('DEV_CHECKSUM fix text', () => {
  it('labels the bare UPDATE as a last resort', () => {
    const a = file('870_a.sql');
    const r = run([a], [{ name: a.name, checksum: 'edited' }], [row(a)]);
    const fixes = r.findings[0]!.fixes;
    expect(fixes.find((x) => x.includes('UPDATE'))).toMatch(/last resort/i);
  });
});

describe('hasOwnCommit', () => {
  it.each([
    ['CREATE TABLE a(); COMMIT; CREATE TABLE b();', true],
    ['BEGIN;\nCREATE TABLE a();\nCOMMIT;\n', true],
    ['  commit ;', true],
    ['-- COMMIT; in a comment\nSELECT 1;', false],
    ['CREATE TABLE commit_log(id int);', false],
    ['SELECT 1;', false],
    ['CREATE TABLE a();\nEND;', true],
    ['COMMIT TRANSACTION;', true],
    ['COMMIT AND CHAIN;', true],
    ['CREATE TABLE a();\nCOMMIT', true],
    ['CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;', false],
    ['SELECT CASE WHEN true THEN 1 END;', false],
  ])('%j -> %s', (sql, expected) => {
    expect(hasOwnCommit(sql)).toBe(expected);
  });
});

describe('PENDING_VERSION_TAKEN', () => {
  it('fails when a pending file reuses the prefix of a prod-tracked file, before any dev write', () => {
    const onProd = file('872_taken.sql');
    const mine = file('872_other.sql');
    const r = run([onProd, mine], [row(onProd)], [row(onProd)], true);
    expect(r.findings.filter((f) => f.severity === 'FAIL').map((f) => `${f.rule}:${f.name}`)).toEqual(['PENDING_VERSION_TAKEN:872_other.sql']);
    expect(r.ok).toBe(false);
  });

  it('treats 872 and 872b as different prefixes', () => {
    const onProd = file('872b_taken.sql');
    expect(run([onProd, file('872_x.sql')], [row(onProd)], [row(onProd)]).findings.map((f) => f.rule)).not.toContain('PENDING_VERSION_TAKEN');
  });

  it('does not fire for a pending file with a fresh prefix (only DEV_MISSING)', () => {
    const onProd = file('872_taken.sql');
    expect(run([onProd, file('873_new.sql')], [row(onProd)], [row(onProd)]).findings.map((f) => f.rule)).toEqual(['DEV_MISSING']);
  });
});
