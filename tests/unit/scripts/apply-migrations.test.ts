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
});
