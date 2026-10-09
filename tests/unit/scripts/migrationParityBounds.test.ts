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

describe('HISTORIC_DEV_UNTRACKED is a bounded, pinned list', () => {
  it('has the 45 names measured on 2026-10-09', () => {
    expect(HISTORIC_DEV_UNTRACKED.size).toBe(45);
    expect(HISTORIC_DEV_UNTRACKED.has('524_redate_remaining_batch_dated_journals.sql')).toBe(true);
    expect(HISTORIC_DEV_UNTRACKED.has('719_bank_reconciliation_reopen.sql')).toBe(true);
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
  ])('%j -> %s', (sql, expected) => {
    expect(hasOwnCommit(sql)).toBe(expected);
  });
});
