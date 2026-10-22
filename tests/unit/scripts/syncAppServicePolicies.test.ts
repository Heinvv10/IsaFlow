/**
 * S-07b (migration 915): both migration appliers (the runner, and the parity
 * gate's dev apply) end by calling public.app_service_sync_policies(), so a
 * table a later-applied migration adds gets app_service's policies on the
 * same run.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type pg from 'pg';
import { syncAppServicePolicies } from '../../../scripts/lib/migrationFiles';

function client(fnExists: boolean, created = 3): { c: pg.ClientBase; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (text: string) => (text.includes('to_regprocedure')
    ? { rows: [{ f: fnExists ? 'app_service_sync_policies()' : null }] }
    : { rows: [{ n: created }] }));
  return { c: { query } as unknown as pg.ClientBase, query };
}

describe('syncAppServicePolicies', () => {
  it('does nothing before 915 is applied', async () => {
    const { c, query } = client(false);
    expect(await syncAppServicePolicies(c)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('calls the function once 915 is applied and returns how many policies it created', async () => {
    const { c, query } = client(true, 3);
    expect(await syncAppServicePolicies(c)).toBe(3);
    expect(query).toHaveBeenLastCalledWith('SELECT public.app_service_sync_policies() AS n');
  });

  it.each([
    ['scripts/apply-migrations.ts', /await syncAppServicePolicies\(client\)/],
    ['scripts/lib/migrationParityRun.ts', /await syncAppServicePolicies\(dev\)/],
  ])('%s calls it after applying', (file, call) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    const applied = src.search(/await applyOne\(/);
    const synced = src.search(call);
    expect(applied).toBeGreaterThan(-1);
    expect(synced).toBeGreaterThan(applied);
  });
});
