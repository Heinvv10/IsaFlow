import { describe, it, expect } from 'vitest';
import {
  computeChecksum,
  parseVersionFromFilename,
  planApply,
  type MigrationFile,
  type TrackingRow,
} from '../../../scripts/apply-migrations';

describe('parseVersionFromFilename', () => {
  it('extracts version from numeric prefix', () => {
    expect(parseVersionFromFilename('292_foo.sql')).toBe('292');
    expect(parseVersionFromFilename('001_bar.sql')).toBe('001');
  });

  it('preserves letter suffix (e.g. 244b)', () => {
    expect(parseVersionFromFilename('244b_inventory.sql')).toBe('244b');
  });

  it('throws on non-numeric prefix', () => {
    expect(() => parseVersionFromFilename('foo_bar.sql')).toThrow(/numeric prefix/);
  });
});

describe('computeChecksum', () => {
  it('is stable for identical content', () => {
    expect(computeChecksum('SELECT 1;')).toBe(computeChecksum('SELECT 1;'));
  });

  it('differs for different content', () => {
    expect(computeChecksum('SELECT 1;')).not.toBe(computeChecksum('SELECT 2;'));
  });

  it('is 64 hex chars (SHA-256)', () => {
    expect(computeChecksum('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('planApply', () => {
  const files: MigrationFile[] = [
    { version: '292', name: '292_a.sql', content: 'A', checksum: computeChecksum('A') },
    { version: '325', name: '325_b.sql', content: 'B', checksum: computeChecksum('B') },
    { version: '326', name: '326_c.sql', content: 'C', checksum: computeChecksum('C') },
  ];

  it('returns all files when tracking table is empty', () => {
    const plan = planApply(files, []);
    expect(plan.toApply.map((f) => f.version)).toEqual(['292', '325', '326']);
    expect(plan.skipped).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.checksumBackfills).toEqual([]);
  });

  it('skips already-applied files with matching checksums', () => {
    const applied: TrackingRow[] = [
      { version: '292', name: '292_a.sql', checksum: computeChecksum('A') },
      { version: '325', name: '325_b.sql', checksum: computeChecksum('B') },
    ];
    const plan = planApply(files, applied);
    expect(plan.toApply.map((f) => f.version)).toEqual(['326']);
    expect(plan.skipped.map((f) => f.version)).toEqual(['292', '325']);
    expect(plan.conflicts).toEqual([]);
  });

  it('classifies null-checksum tracked rows as checksumBackfills (not conflicts)', () => {
    const applied: TrackingRow[] = [
      { version: '292', name: '292_a.sql', checksum: null },
      { version: '325', name: '325_b.sql', checksum: null },
    ];
    const plan = planApply(files, applied);
    expect(plan.checksumBackfills.map((f) => f.version)).toEqual(['292', '325']);
    expect(plan.conflicts).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.toApply.map((f) => f.version)).toEqual(['326']);
  });

  it('flags checksum mismatches as conflicts and excludes from toApply', () => {
    const applied: TrackingRow[] = [
      { version: '292', name: '292_a.sql', checksum: 'WRONG' },
    ];
    const plan = planApply(files, applied);
    expect(plan.conflicts.map((c) => c.version)).toEqual(['292']);
    expect(plan.toApply.map((f) => f.version)).toEqual(['325', '326']);
  });

  it('sorts toApply by version ascending', () => {
    const shuffled = [files[2]!, files[0]!, files[1]!];
    const plan = planApply(shuffled, []);
    expect(plan.toApply.map((f) => f.version)).toEqual(['292', '325', '326']);
  });

  it('orders letter-suffix variants after plain numeric (244 < 244b)', () => {
    const mixed: MigrationFile[] = [
      { version: '244b', name: '244b_inventory.sql', content: 'I', checksum: computeChecksum('I') },
      { version: '244', name: '244_fixed_assets.sql', content: 'F', checksum: computeChecksum('F') },
    ];
    const plan = planApply(mixed, []);
    expect(plan.toApply.map((f) => f.version)).toEqual(['244', '244b']);
  });

  it('tracks by filename not version: two files sharing a version are independent', () => {
    // Historical repo has 9 cases where two different files share a numeric
    // prefix (e.g. 245_inventory.sql + 245_company_settings.sql).
    const duplicateVersionFiles: MigrationFile[] = [
      { version: '245', name: '245_inventory.sql', content: 'I', checksum: computeChecksum('I') },
      { version: '245', name: '245_company_settings.sql', content: 'C', checksum: computeChecksum('C') },
    ];
    const applied: TrackingRow[] = [
      { version: '245', name: '245_inventory.sql', checksum: computeChecksum('I') },
    ];
    const plan = planApply(duplicateVersionFiles, applied);
    // Only the one with a matching filename entry should be skipped.
    expect(plan.skipped.map((f) => f.name)).toEqual(['245_inventory.sql']);
    expect(plan.toApply.map((f) => f.name)).toEqual(['245_company_settings.sql']);
    expect(plan.conflicts).toEqual([]);
  });
});
