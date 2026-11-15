/** A migration added on a branch must have a numeric prefix no other file in scripts/migrations/sql/ uses (#1380). */
import { describe, expect, it } from 'vitest';
import { findNewPrefixCollisions, migrationPrefix } from '../../../scripts/ci/newMigrationPrefixRule';

const existing = ['244_fixed_assets.sql', '244b_inventory.sql', '300_a.sql'];

describe('new migration prefixes', () => {
  it('reads the leading digits', () => {
    expect(migrationPrefix('244b_inventory.sql')).toBe('244');
    expect(migrationPrefix('x_1.sql')).toBeNull();
  });

  it('fails an added file sharing a prefix, letter suffix included', () => {
    expect(findNewPrefixCollisions(['300b_b.sql'], [...existing, '300b_b.sql'])).toHaveLength(1);
    expect(findNewPrefixCollisions(['300_b.sql'], [...existing, '300_b.sql'])[0]).toContain('300_a.sql');
  });

  it('fails two files added with one prefix', () => {
    expect(findNewPrefixCollisions(['301_a.sql', '301_b.sql'], [...existing, '301_a.sql', '301_b.sql'])).toHaveLength(2);
  });

  it('fails an added file with no number', () => {
    expect(findNewPrefixCollisions(['fix.sql'], [...existing, 'fix.sql'])).toHaveLength(1);
  });

  it('passes a unique prefix and ignores the historic duplicates', () => {
    expect(findNewPrefixCollisions(['301_c.sql'], [...existing, '301_c.sql'])).toEqual([]);
    expect(findNewPrefixCollisions([], existing)).toEqual([]);
  });
});
