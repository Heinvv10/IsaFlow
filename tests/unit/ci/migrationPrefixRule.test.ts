/**
 * migrationPrefixRule: the PR-time copy of the deploy parity gate's
 * DUPLICATE_PENDING_VERSION / PENDING_VERSION_TAKEN rules (issue #1380).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { findPrefixClashes, HISTORIC_PREFIX_CLASHES } from '../../../scripts/ci/migrationPrefixRule';

const repoMigrations = (): string[] =>
  readdirSync(join(process.cwd(), 'scripts', 'migrations', 'sql')).filter((f) => f.endsWith('.sql'));

describe('findPrefixClashes', () => {
  it('fails two new files on one version (the 14 Nov 990_ deploy abort)', () => {
    const clashes = findPrefixClashes(['989_a.sql', '990_proof_x.sql', '990_proof_y.sql'], new Set(), new Set());
    expect(clashes.map((c) => c.name).sort()).toEqual(['990_proof_x.sql', '990_proof_y.sql']);
    expect(clashes[0]!.detail).toContain('version 990');
  });

  it('treats 244 and 244b as different versions, as the runner does', () => {
    expect(findPrefixClashes(['244_a.sql', '244b_b.sql'], new Set(), new Set())).toEqual([]);
  });

  it('fails a new file on a version prod tracks for a file no longer in the repo', () => {
    const clashes = findPrefixClashes(['462_new.sql'], new Set(), new Set(['462_bank_transfer_allocation.sql']));
    expect(clashes).toEqual([
      { name: '462_new.sql', detail: expect.stringContaining('tracked on prod by 462_bank_transfer_allocation.sql') },
    ]);
  });

  it('ignores historic clashes but still fails a new file joining one', () => {
    const historic = new Set(['341_a.sql', '341_b.sql']);
    expect(findPrefixClashes(['341_a.sql', '341_b.sql'], historic, new Set())).toEqual([]);
    const clashes = findPrefixClashes(['341_a.sql', '341_b.sql', '341_new.sql'], historic, new Set());
    expect(clashes.map((c) => c.name)).toEqual(['341_new.sql']);
  });

  it('accepts 1000_ after 999_: it clashes with neither 100_ nor 999_', () => {
    expect(findPrefixClashes(['100_a.sql', '999_b.sql', '999b_c.sql', '1000_d.sql'], new Set(), new Set())).toEqual([]);
    expect(findPrefixClashes(['1000_d.sql', '1000_e.sql'], new Set(), new Set()).map((c) => c.name)).toEqual(['1000_d.sql', '1000_e.sql']);
  });

  it('fails a filename the runner cannot parse', () => {
    expect(findPrefixClashes(['add_table.sql'], new Set(), new Set()).map((c) => c.name)).toEqual(['add_table.sql']);
  });
});

describe('the repo migrations', () => {
  it('have no clash outside the frozen historic list', () => {
    expect(findPrefixClashes(repoMigrations())).toEqual([]);
  });

  it('still contain every historic name (the list stays exact)', () => {
    const present = new Set(repoMigrations());
    expect([...HISTORIC_PREFIX_CLASHES].filter((n) => !present.has(n))).toEqual([]);
  });
});
