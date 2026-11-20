/** The database's "can write" (migration 1002, intercompany_user_can_write) names the same roles as the application's DEFAULT_WRITE_ROLES. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WRITE_ROLES } from '@/lib/auth/writeRoles';

describe('intercompany_user_can_write', () => {
  it('lists exactly DEFAULT_WRITE_ROLES', () => {
    const sql = readFileSync(resolve(__dirname, '../../../../scripts/migrations/sql/1002_intercompany_round2.sql'), 'utf8');
    const m = /cu\.role = ANY \(ARRAY\[([^\]]+)\]\)/.exec(sql);
    expect(m).not.toBeNull();
    const roles = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(roles.sort()).toEqual([...DEFAULT_WRITE_ROLES].sort());
  });
});
