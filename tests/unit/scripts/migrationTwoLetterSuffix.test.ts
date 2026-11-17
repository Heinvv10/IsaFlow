/**
 * Two-letter migration suffixes (999za_ … 999zz_). Every single-letter 999
 * prefix was taken (wave 6, 2026-11-17), so the rule became "digits plus one or
 * two lowercase letters". Every parser of a migration version must read the
 * two-letter form, and none may change how an existing name parses. A parser
 * that misses it does not fail loudly: the runner throws, the parity gate's
 * PENDING_VERSION_TAKEN check skips the prod row, the oauth trust-flag gate
 * skips the file, and the bash order puts it in the wrong place.
 */
import { execFileSync } from 'child_process';
import { readdirSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { planApply, type MigrationFile } from '../../../scripts/apply-migrations';
import { migrationNumber as oauthMigrationNumber } from '../../../scripts/ci/oauthTrustFlagRule';
import { findPrefixClashes } from '../../../scripts/ci/migrationPrefixRule';
import {
  compareMigrationNames,
  compareMigrations,
  MIGRATIONS_DIR,
  parseVersionFromFilename,
} from '../../../scripts/lib/migrationFiles';
import { classifyMigrationParity, type ParityFile } from '../../../scripts/lib/migrationParity';
import { migrationNumber as censusMigrationNumber } from '../helpers/sourceCensus';

const mf = (name: string): MigrationFile => ({
  name,
  version: parseVersionFromFilename(name),
  content: '',
  checksum: `sum-${name}`,
});
const pf = (name: string): ParityFile => ({ name, version: parseVersionFromFilename(name), checksum: `sum-${name}` });

// Shuffled on purpose: every expectation below is the sorted order.
const MIXED = ['999zz_last.sql', '1000_next.sql', '999za_first.sql', '999z_single.sql', '999_top.sql',
  '999zb_second.sql', '999a_one.sql', '998_below.sql', '999az_between.sql', '999b_two.sql'];
const ORDERED = ['998_below.sql', '999_top.sql', '999a_one.sql', '999az_between.sql', '999b_two.sql',
  '999z_single.sql', '999za_first.sql', '999zb_second.sql', '999zz_last.sql', '1000_next.sql'];

describe('parseVersionFromFilename', () => {
  it.each([
    ['999za_x.sql', '999za'],
    ['999zz_x.sql', '999zz'],
    ['999a_x.sql', '999a'],
    ['960_x.sql', '960'],
    ['244b_x.sql', '244b'],
    ['1000_x.sql', '1000'],
  ])('%s -> %s', (name, version) => {
    expect(parseVersionFromFilename(name)).toBe(version);
  });

  it.each(['999A_x.sql', '999abc_x.sql', '999Za_x.sql', 'za_x.sql', '999-za_x.sql'])('refuses %s', (name) => {
    expect(() => parseVersionFromFilename(name)).toThrow(/missing numeric prefix/);
  });
});

describe('order (runner, loader and parity gate share compareMigrations)', () => {
  it.each([
    ['999z_a.sql', '999za_a.sql'],
    ['999za_a.sql', '999zb_a.sql'],
    ['999zb_a.sql', '999zz_a.sql'],
    ['999_a.sql', '999za_a.sql'],
    ['999zz_a.sql', '1000_a.sql'],
  ])('%s sorts before %s', (a, b) => {
    expect(compareMigrationNames(a, b)).toBeLessThan(0);
    expect(compareMigrationNames(b, a)).toBeGreaterThan(0);
  });

  it('sorts a mixed set, and the string order of 3-digit names agrees', () => {
    expect([...MIXED].sort(compareMigrationNames)).toEqual(ORDERED);
    expect(MIXED.map(mf).sort(compareMigrations).map((f) => f.name)).toEqual(ORDERED);
    const threeDigit = MIXED.filter((n) => !n.startsWith('1000'));
    expect([...threeDigit].sort()).toEqual(ORDERED.filter((n) => !n.startsWith('1000')));
  });

  it('planApply applies the pending two-letter files in order with no conflicts', () => {
    const files = MIXED.map(mf);
    const applied = files.filter((f) => /^(998|999|999a|999b|999z)_/.test(f.name)).map((f) => ({ ...f }));
    const plan = planApply(files, applied);
    expect(plan.toApply.map((f) => f.name)).toEqual([
      '999az_between.sql', '999za_first.sql', '999zb_second.sql', '999zz_last.sql', '1000_next.sql',
    ]);
    expect(plan.conflicts).toEqual([]);
  });

  it('the parity gate queues dev applies in the same order', () => {
    expect(classifyMigrationParity(MIXED.map(pf), [], [], { applyDev: true }).devMissing).toEqual(ORDERED);
  });

  it('migration-order.sh (refresh-baseline) gives the same order, repo set included', () => {
    const bash = (names: string[]) =>
      execFileSync('bash', ['-c', 'source scripts/ci/integration/migration-order.sh && mig_order'], {
        input: names.join('\n') + '\n',
        encoding: 'utf8',
      }).trim().split('\n');
    expect(bash(MIXED)).toEqual(ORDERED);
    const repo = [...readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')), '999za_probe.sql', '999zb_probe.sql'];
    expect(bash([...repo].reverse())).toEqual([...repo].sort(compareMigrationNames));
  });
});

describe('the deploy parity gate (PENDING_VERSION_TAKEN)', () => {
  it('fails a pending file whose two-letter version prod already tracks under another name', () => {
    const r = classifyMigrationParity(
      [pf('999za_mine.sql')],
      [{ name: '999za_theirs.sql', checksum: 'x' }],
      [{ name: '999za_theirs.sql', checksum: 'x' }],
      { applyDev: false },
    );
    expect(r.findings.filter((f) => f.rule === 'PENDING_VERSION_TAKEN').map((f) => f.name)).toEqual(['999za_mine.sql']);
  });

  it('does not confuse 999z with 999za', () => {
    const r = classifyMigrationParity(
      [pf('999za_mine.sql')],
      [{ name: '999z_theirs.sql', checksum: 'x' }],
      [{ name: '999z_theirs.sql', checksum: 'x' }],
      { applyDev: false },
    );
    expect(r.findings.filter((f) => f.rule === 'PENDING_VERSION_TAKEN')).toEqual([]);
  });
});

describe('naming audit (migration-naming CI step)', () => {
  it('accepts 999za_ beside 999z_ and 999zb_', () => {
    expect(findPrefixClashes(['999z_a.sql', '999za_b.sql', '999zb_c.sql', '999zz_d.sql'], new Set(), new Set())).toEqual([]);
  });

  it('refuses two files sharing 999za', () => {
    const clashes = findPrefixClashes(['999za_x.sql', '999za_y.sql'], new Set(), new Set());
    expect(clashes.map((c) => c.name)).toEqual(['999za_x.sql', '999za_y.sql']);
    expect(clashes[0]!.detail).toContain('version 999za');
  });

  it.each(['999A_x.sql', '999abc_x.sql'])('still refuses %s', (name) => {
    expect(findPrefixClashes([name], new Set(), new Set()).map((c) => c.name)).toEqual([name]);
  });
});

describe('number readers (oauth trust-flag gate, source census)', () => {
  it('read 999za_ as 999, not as missing', () => {
    expect(oauthMigrationNumber('scripts/migrations/sql/999za_x.sql')).toBe(999);
    expect(censusMigrationNumber('scripts/migrations/sql/999zz_x.sql')).toBe(999);
    expect(oauthMigrationNumber('scripts/migrations/sql/880b_x.sql')).toBe(880);
    expect(censusMigrationNumber('scripts/migrations/sql/1000_x.sql')).toBe(1000);
  });
});
