/**
 * Migration ordering is numeric-aware. Every 3-digit prefix is used (999 is the
 * highest), so the next migration is 1000_, which a string sort puts BEFORE
 * 100_: the runner would apply it ahead of the schema it builds on. One
 * comparator (scripts/lib/migrationFiles.ts) orders the runner, the parity gate
 * and the file loader; refresh-baseline.sh has its bash equivalent.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { planApply, type MigrationFile } from '../../../scripts/apply-migrations';
import {
  compareMigrationNames,
  compareMigrations,
  loadMigrationFiles,
  MIGRATIONS_DIR,
} from '../../../scripts/lib/migrationFiles';
import { classifyMigrationParity, type ParityFile } from '../../../scripts/lib/migrationParity';
import { parseExpectedSchema } from '../../../scripts/lib/schemaDriftParse';
import { migrationNumber } from '../helpers/sourceCensus';

const version = (name: string) => /^(\d+[a-z]?)_/.exec(name)![1]!;
const mf = (name: string): MigrationFile => ({ name, version: version(name), content: '', checksum: `sum-${name}` });
const pf = (name: string): ParityFile => ({ name, version: version(name), checksum: `sum-${name}` });

// Shuffled on purpose: every expectation below is the sorted order.
const MIXED = ['1000_next.sql', '100_old.sql', '999b_z.sql', '244b_inv.sql', '999_top.sql', '1001_after.sql',
  '245_inventory.sql', '244_assets.sql', '245_company_settings.sql', '99_tiny.sql', '999a_y.sql'];
const ORDERED = ['99_tiny.sql', '100_old.sql', '244_assets.sql', '244b_inv.sql', '245_company_settings.sql',
  '245_inventory.sql', '999_top.sql', '999a_y.sql', '999b_z.sql', '1000_next.sql', '1001_after.sql'];

describe('compareMigrationNames', () => {
  it.each([
    ['999_a.sql', '999b_a.sql'],
    ['999b_a.sql', '1000_a.sql'],
    ['100_a.sql', '1000_a.sql'],
    ['999_a.sql', '1000_a.sql'],
    ['244_a.sql', '244b_a.sql'],
    ['244a_a.sql', '244b_a.sql'],
    ['9_a.sql', '10_a.sql'],
    ['245_company_settings.sql', '245_inventory.sql'], // same version: the name breaks the tie
  ])('%s sorts before %s', (a, b) => {
    expect(compareMigrationNames(a, b)).toBeLessThan(0);
    expect(compareMigrationNames(b, a)).toBeGreaterThan(0);
  });

  it('is 0 only for the same name', () => {
    expect(compareMigrationNames('1000_a.sql', '1000_a.sql')).toBe(0);
  });

  it('sorts a mixed set numerically', () => {
    expect([...MIXED].sort(compareMigrationNames)).toEqual(ORDERED);
  });

  it('compareMigrations orders {version, name} the same way', () => {
    expect(MIXED.map(mf).sort(compareMigrations).map((f) => f.name)).toEqual(ORDERED);
  });

  it('gives the repo set the same order a string sort gives while every prefix has 3 digits', () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && /^\d{3}[a-z]?_/.test(f));
    expect(names.length).toBeGreaterThan(500);
    expect([...names].sort(compareMigrationNames)).toEqual([...names].sort());
  });
});

describe('loadMigrationFiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-order-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns files in numeric order', () => {
    for (const name of MIXED) writeFileSync(join(dir, name), `-- ${name}\n`);
    expect(loadMigrationFiles(dir).map((f) => f.name)).toEqual(ORDERED);
  });
});

describe('planApply (the runner)', () => {
  it('applies 1000_ after every 3-digit migration', () => {
    const plan = planApply(MIXED.map(mf), []);
    expect(plan.toApply.map((f) => f.name)).toEqual(ORDERED);
  });

  it('applies only the pending 1000_ when everything below is tracked', () => {
    const files = MIXED.map(mf);
    const applied = files.filter((f) => !f.name.startsWith('100')).map((f) => ({ ...f }));
    const plan = planApply(files, applied);
    expect(plan.toApply.map((f) => f.name)).toEqual(['100_old.sql', '1000_next.sql', '1001_after.sql']);
  });
});

describe('classifyMigrationParity (the deploy gate)', () => {
  it('queues the dev applies of a mixed set in numeric order', () => {
    const r = classifyMigrationParity(MIXED.map(pf), [], [], { applyDev: true });
    expect(r.devMissing).toEqual(ORDERED);
  });
});

describe('refresh-baseline.sh order (scripts/ci/integration/migration-order.sh)', () => {
  const bash = (fn: string, names: string[], arg = '') =>
    execFileSync('bash', ['-c', `source scripts/ci/integration/migration-order.sh && ${fn} "$1"`, 'bash', arg], {
      input: names.join('\n') + '\n',
      encoding: 'utf8',
    }).trim().split('\n');

  it('mig_order equals compareMigrationNames on the mixed set and on the repo set plus a 1000_', () => {
    expect(bash('mig_order', MIXED)).toEqual(ORDERED);
    const repo = [...readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')), '1000_probe.sql'];
    expect(bash('mig_order', [...repo].reverse())).toEqual([...repo].sort(compareMigrationNames));
  });

  it('mig_below keeps the files strictly before the top, in order', () => {
    expect(bash('mig_below', MIXED, '1000_next.sql')).toEqual(ORDERED.slice(0, ORDERED.indexOf('1000_next.sql')));
    expect(bash('mig_below', MIXED, '999_top.sql')).not.toContain('1000_next.sql');
  });
});

describe('schemaDriftParse replays migrations in numeric order', () => {
  it('a 1000_ rename and drop act on what 999_ created, not before it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-order-'));
    try {
      writeFileSync(join(dir, '999_create.sql'), 'CREATE TABLE IF NOT EXISTS o_t (id uuid, old_name text);\nCREATE TABLE IF NOT EXISTS o_gone (id uuid);\n');
      writeFileSync(join(dir, '1000_change.sql'), 'ALTER TABLE o_t RENAME COLUMN old_name TO new_name;\nDROP TABLE IF EXISTS o_gone;\n');
      const expected = parseExpectedSchema(dir);
      expect([...(expected.get('o_t') ?? [])].sort()).toEqual(['id', 'new_name']);
      expect(expected.has('o_gone')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sourceCensus.migrationNumber', () => {
  it('reads every leading digit', () => {
    expect(migrationNumber('scripts/migrations/sql/1000_x.sql')).toBe(1000);
    expect(migrationNumber('scripts/migrations/sql/880b_x.sql')).toBe(880);
    expect(migrationNumber('scripts/migrations/sql/099_x.sql')).toBe(99);
  });
});
