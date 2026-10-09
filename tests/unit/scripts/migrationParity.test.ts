import { describe, it, expect } from 'vitest';
import {
  classifyMigrationParity,
  HISTORIC_PROD_ORPHANS,
  type ParityFile,
  type ParityRow,
} from '../../../scripts/lib/migrationParity';

const file = (name: string, checksum = `sum-${name}`): ParityFile => ({
  name,
  version: /^(\d+[a-z]?)_/.exec(name)![1]!,
  checksum,
});
const row = (f: ParityFile, checksum: string | null = f.checksum): ParityRow => ({
  name: f.name,
  checksum,
});

const A = file('870_a.sql');
const B = file('871_b.sql');
const OLD = file('600_old.sql');

const rules = (r: ReturnType<typeof classifyMigrationParity>) =>
  r.findings.map((x) => `${x.rule}:${x.name}`).sort();

describe('classifyMigrationParity', () => {
  it('is clean when dev and prod both carry every file with equal checksums', () => {
    const r = classifyMigrationParity([A, B], [row(A), row(B)], [row(A), row(B)], { applyDev: false });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // Rule a
  it('PROD_AHEAD: prod tracks a migration the repo does not have', () => {
    const ghost = file('872_ghost.sql');
    const r = classifyMigrationParity([A], [row(A)], [row(A), row(ghost)], { applyDev: true });
    expect(rules(r)).toEqual(['PROD_AHEAD:872_ghost.sql']);
    expect(r.findings[0]!.severity).toBe('FAIL');
    expect(r.ok).toBe(false);
  });

  it('PROD_AHEAD: the 13 historic renamed/deleted prod rows are allowlisted, counted, not failed', () => {
    const orphans = [...HISTORIC_PROD_ORPHANS].map((name) => ({ name, checksum: 'x' }));
    expect(orphans).toHaveLength(13);
    const r = classifyMigrationParity([A], [row(A)], [row(A), ...orphans], { applyDev: false });
    expect(r.findings).toEqual([]);
    expect(r.ignoredOrphans).toBe(13);
    expect(r.ok).toBe(true);
  });

  // Rule b
  it('PROD_CHECKSUM: prod checksum differs from the repo file', () => {
    const r = classifyMigrationParity([A], [row(A)], [row(A, 'other')], { applyDev: true });
    expect(rules(r)).toEqual(['PROD_CHECKSUM:870_a.sql']);
    expect(r.ok).toBe(false);
  });

  it('a NULL prod checksum (legacy row) is not a mismatch', () => {
    const r = classifyMigrationParity([A], [row(A)], [row(A, null)], { applyDev: false });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // Rule c
  it('DEV_CHECKSUM: tracked on both, dev checksum differs', () => {
    const r = classifyMigrationParity([A], [row(A, 'edited')], [row(A)], { applyDev: true });
    expect(rules(r)).toEqual(['DEV_CHECKSUM:870_a.sql']);
    expect(r.ok).toBe(false);
    const fixes = r.findings[0]!.fixes.join('\n');
    expect(fixes).toContain('psql');
    expect(fixes).toContain('-1');
    expect(fixes).toContain(A.checksum);
    expect(fixes).toContain('UPDATE schema_migrations');
  });

  it('DEV_CHECKSUM: pending on prod but tracked on dev with a different checksum', () => {
    const r = classifyMigrationParity([B], [row(B, 'edited')], [], { applyDev: true });
    expect(rules(r)).toEqual(['DEV_CHECKSUM:871_b.sql']);
    expect(r.devMissing).toEqual([]);
  });

  it('a NULL dev checksum is not a mismatch', () => {
    const r = classifyMigrationParity([A], [row(A, null)], [row(A)], { applyDev: false });
    expect(r.findings).toEqual([]);
  });

  it('does not auto-fix DEV_CHECKSUM even with applyDev', () => {
    const r = classifyMigrationParity([A], [row(A, 'edited')], [row(A)], { applyDev: true });
    expect(r.devMissing).toEqual([]);
    expect(r.ok).toBe(false);
  });

  // Rule d
  it('DEV_MISSING: pending file not on dev is FAIL without applyDev, with a psql fix', () => {
    const r = classifyMigrationParity([A, B], [row(A)], [row(A)], { applyDev: false });
    expect(rules(r)).toEqual(['DEV_MISSING:871_b.sql']);
    expect(r.findings[0]!.severity).toBe('FAIL');
    expect(r.findings[0]!.fixes.join('\n')).toContain('871_b.sql');
    expect(r.findings[0]!.fixes.join('\n')).toContain('psql');
    expect(r.ok).toBe(false);
  });

  it('DEV_MISSING: with applyDev it is FIX (not fatal) and queued in name order', () => {
    const c = file('872_c.sql');
    const b2 = file('871_b.sql');
    const r = classifyMigrationParity([c, b2, A], [row(A)], [row(A)], { applyDev: true });
    expect(r.findings.every((f) => f.severity === 'FIX')).toBe(true);
    expect(r.devMissing).toEqual(['871_b.sql', '872_c.sql']);
    expect(r.ok).toBe(true);
  });

  it('orders duplicate-version files by name and letter suffixes after the bare number', () => {
    const x = file('245_inventory.sql');
    const y = file('245_company_settings.sql');
    const z = file('245b_z.sql');
    const r = classifyMigrationParity([z, x, y], [], [], { applyDev: true });
    expect(r.devMissing).toEqual(['245_company_settings.sql', '245_inventory.sql', '245b_z.sql']);
  });

  it('no prod rows: every file is pending, so every file must be on dev', () => {
    const r = classifyMigrationParity([A, B], [row(A)], [], { applyDev: false });
    expect(rules(r)).toEqual(['DEV_MISSING:871_b.sql']);
  });

  // Rule e
  it('IGNORED: old files on prod but untracked on dev are only counted', () => {
    const r = classifyMigrationParity([OLD, A], [row(A)], [row(OLD), row(A)], { applyDev: false });
    expect(r.findings).toEqual([]);
    expect(r.ignoredHistoric).toBe(1);
    expect(r.ok).toBe(true);
  });

  it('a prod-tracked file missing on dev is never DEV_MISSING', () => {
    const r = classifyMigrationParity([OLD], [], [row(OLD)], { applyDev: true });
    expect(r.devMissing).toEqual([]);
    expect(r.ignoredHistoric).toBe(1);
  });

  it('reports every independent failure together', () => {
    const ghost = file('900_ghost.sql');
    const r = classifyMigrationParity(
      [A, B],
      [row(A, 'edited')],
      [row(A, 'x'), row(ghost)],
      { applyDev: false }
    );
    expect(rules(r)).toEqual([
      'DEV_CHECKSUM:870_a.sql',
      'DEV_MISSING:871_b.sql',
      'PROD_AHEAD:900_ghost.sql',
      'PROD_CHECKSUM:870_a.sql',
    ]);
  });
});
