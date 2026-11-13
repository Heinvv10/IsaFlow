/**
 * The disposable-stack flag writer (tests/e2e/golden-paths/helpers/hostedFeatureFlag.ts, z19's flag-off step) writes
 * company_feature_overrides, so every refusal must hold before it connects, and the server must confirm the database
 * and the seeded company before any write. A real Demo company (another name) is never written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pg = vi.hoisted(() => ({ connects: 0, writes: [] as string[], db: 'isaflow_golden', company: 'IsaDemo (Golden Paths CI)' }));

vi.mock('pg', () => {
  class Client {
    async connect(): Promise<void> { pg.connects += 1; }
    async query(text: string): Promise<{ rows: unknown[] }> {
      if (text.includes('current_database')) return { rows: [{ db: pg.db }] };
      if (text.includes('FROM companies')) return { rows: [{ name: pg.company }] };
      if (text.includes('FROM feature_flags')) return { rows: [{ id: 'f1' }] };
      if (text.startsWith('SELECT enabled')) return { rows: [] };
      pg.writes.push(text.trim().split(/\s+/)[0]!);
      return { rows: [] };
    }
    async end(): Promise<void> { /* closed */ }
  }
  return { default: { Client } };
});

import { hostedFlagAvailable, setHostedFlag } from '../../e2e/golden-paths/helpers/hostedFeatureFlag';

const ok = {
  GOLDEN_HOSTED_DB_URL: 'postgresql://postgres@127.0.0.1:5555/isaflow_golden', GOLDEN_HOSTED_ADMIN_ID: 'a1',
  GOLDEN_HOSTED_PGPASSWORD: 'x', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
} as NodeJS.ProcessEnv;

beforeEach(() => { pg.connects = 0; pg.writes = []; pg.db = 'isaflow_golden'; pg.company = 'IsaDemo (Golden Paths CI)'; });

describe('setHostedFlag', () => {
  it('unavailable without the stack variables (dev, production verify)', () => {
    expect(hostedFlagAvailable({} as NodeJS.ProcessEnv)).toBe(false);
    expect(hostedFlagAvailable(ok)).toBe(true);
  });

  it.each([
    ['outside a hosted runner without GOLDEN_HOSTED_LOCAL', { GITHUB_ACTIONS: undefined }],
    ['a non-loopback host', { GOLDEN_HOSTED_DB_URL: 'postgresql://postgres@10.0.0.5:5555/isaflow_golden' }],
    ['another database', { GOLDEN_HOSTED_DB_URL: 'postgresql://postgres@127.0.0.1:7772/isaflow_dev' }],
  ])('refuses %s before connecting', async (_n, over) => {
    await expect(setHostedFlag('c1', 'budgets_three_way', false, { ...ok, ...over } as NodeJS.ProcessEnv)).rejects.toThrow();
    expect(pg.connects).toBe(0);
  });

  it('refuses when the server is another database, or the company is not the seeded one: nothing written', async () => {
    pg.db = 'isaflow_dev';
    await expect(setHostedFlag('c1', 'budgets_three_way', false, ok)).rejects.toThrow(/nothing written/);
    pg.db = 'isaflow_golden';
    pg.company = 'IsaDemo';
    await expect(setHostedFlag('c1', 'budgets_three_way', false, ok)).rejects.toThrow(/seeded company/);
    expect(pg.writes).toEqual([]);
  });

  it('GOLDEN_HOSTED_LOCAL=1 stands in for the runner; writes an upsert, or a delete for null', async () => {
    const local = { ...ok, GITHUB_ACTIONS: undefined, GOLDEN_HOSTED_LOCAL: '1' } as NodeJS.ProcessEnv;
    expect(await setHostedFlag('c1', 'budgets_three_way', true, local)).toBeNull();
    await setHostedFlag('c1', 'budgets_three_way', null, local);
    expect(pg.writes).toEqual(['INSERT', 'DELETE']);
  });
});
