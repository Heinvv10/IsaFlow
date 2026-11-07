/**
 * The hosted Golden Paths counter reset (tests/e2e/golden-paths/helpers/hostedOnboardingLimit.ts) deletes a row,
 * so every refusal must hold before it connects, and the server must confirm the database before the DELETE.
 * On velo, 127.0.0.1:7772 is isaflow_dev: loopback alone proves nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pgState = vi.hoisted(() => ({
  connects: 0,
  queries: [] as string[],
  ends: 0,
  db: 'isaflow_golden',
}));

vi.mock('pg', () => {
  class Client {
    async connect(): Promise<void> { pgState.connects += 1; }
    async query(text: string): Promise<{ rows: Array<{ db: string }> }> {
      pgState.queries.push(text);
      return { rows: text.includes('current_database') ? [{ db: pgState.db }] : [] };
    }
    async end(): Promise<void> { pgState.ends += 1; }
  }
  return { default: { Client } };
});

import { resetHostedOnboardingLimit } from '../../e2e/golden-paths/helpers/hostedOnboardingLimit';

const HOSTED = {
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GOLDEN_HOSTED_DB_URL: 'postgresql://postgres@127.0.0.1:36363/isaflow_golden',
  GOLDEN_HOSTED_ADMIN_ID: '8405f765-247b-4403-ab4e-a3bb4249e1b7',
  GOLDEN_HOSTED_PGPASSWORD: 'run-local',
} as const;

const deletes = (): string[] => pgState.queries.filter((q) => q.startsWith('DELETE'));

beforeEach(() => {
  pgState.connects = 0;
  pgState.queries = [];
  pgState.ends = 0;
  pgState.db = 'isaflow_golden';
});

describe('resetHostedOnboardingLimit', () => {
  it('is a no-op without the variables (dev, post-deploy)', async () => {
    await expect(resetHostedOnboardingLimit({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' })).resolves.toBe(false);
    expect(pgState.connects).toBe(0);
  });

  it('deletes the admin\'s one counter row on a hosted runner\'s isaflow_golden', async () => {
    await expect(resetHostedOnboardingLimit({ ...HOSTED })).resolves.toBe(true);
    expect(deletes()).toEqual(['DELETE FROM rate_limit_counters WHERE key = $1']);
    expect(pgState.ends).toBe(1);
  });

  it('refuses velo\'s dev database on 127.0.0.1:7772 even with every GOLDEN_HOSTED_* set', async () => {
    await expect(resetHostedOnboardingLimit({
      ...HOSTED, GOLDEN_HOSTED_DB_URL: 'postgresql://postgres@127.0.0.1:7772/isaflow_dev',
    })).rejects.toThrow(/must name the database isaflow_golden/);
    expect(pgState.connects).toBe(0);
    expect(deletes()).toEqual([]);
  });

  it.each([
    ['GITHUB_ACTIONS unset', { GITHUB_ACTIONS: undefined }],
    ['GITHUB_ACTIONS not "true"', { GITHUB_ACTIONS: '1' }],
    ['a self-hosted runner (velo)', { RUNNER_ENVIRONMENT: 'self-hosted' }],
    ['RUNNER_ENVIRONMENT unset', { RUNNER_ENVIRONMENT: undefined }],
  ])('refuses outside a GitHub-hosted runner: %s', async (_name, over) => {
    await expect(resetHostedOnboardingLimit({ ...HOSTED, ...over })).rejects.toThrow(/outside a GitHub-hosted runner/);
    expect(pgState.connects).toBe(0);
  });

  it('refuses a host that is not loopback', async () => {
    await expect(resetHostedOnboardingLimit({
      ...HOSTED, GOLDEN_HOSTED_DB_URL: 'postgresql://postgres@10.0.0.5:5432/isaflow_golden',
    })).rejects.toThrow(/not 10\.0\.0\.5/);
    expect(pgState.connects).toBe(0);
  });

  it.each(['/isaflow_golden_x', '/isaflow_golden/', '/', ''])('refuses a database path other than /isaflow_golden: %j', async (p) => {
    await expect(resetHostedOnboardingLimit({
      ...HOSTED, GOLDEN_HOSTED_DB_URL: `postgresql://postgres@127.0.0.1:36363${p}`,
    })).rejects.toThrow(/must name the database isaflow_golden/);
    expect(pgState.connects).toBe(0);
  });

  it('refuses when the server it reached is another database, and deletes nothing', async () => {
    pgState.db = 'isaflow_dev';
    await expect(resetHostedOnboardingLimit({ ...HOSTED })).rejects.toThrow(/connected to isaflow_dev/);
    expect(deletes()).toEqual([]);
    expect(pgState.ends).toBe(1);
  });
});
