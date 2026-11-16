// The wave-6 golden QA user: the login the specs read and the membership the provisioner insists on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { membershipProblems, W6_COMPANY_NAME } from '../../../scripts/ci/golden/provision-w6-qa';
import { readW6Qa } from '../../e2e/golden-paths/helpers/w6QaUser';

const ID = '11111111-2222-4333-8444-555555555555';
const sandbox = { id: ID, name: W6_COMPANY_NAME, role: 'owner' };

describe('membershipProblems', () => {
  it('accepts exactly the sandbox, as owner', () => expect(membershipProblems([sandbox])).toEqual([]));
  it('refuses a second company', () => {
    expect(membershipProblems([sandbox, { id: 'x', name: 'ISAFlow Demo', role: 'owner' }])[0]).toMatch(/belongs to 2 companies/);
  });
  it('refuses no company, another company, and a non-owner role', () => {
    expect(membershipProblems([])[0]).toMatch(/belongs to 0 companies/);
    expect(membershipProblems([{ ...sandbox, name: 'Other' }])[0]).toMatch(/not "0W6 Golden Sandbox"/);
    expect(membershipProblems([{ ...sandbox, role: 'viewer' }])[0]).toMatch(/viewer, not owner/);
  });
});

describe('readW6Qa', () => {
  const full = { GOLDEN_QA_W6_EMAIL: 'golden-qa-w6@isaflow.dev', GOLDEN_QA_W6_PASSWORD: 'p', GOLDEN_QA_W6_COMPANY_ID: ID };
  it('reads the three variables', () => expect(readW6Qa(full)).toEqual({ email: full.GOLDEN_QA_W6_EMAIL, password: 'p', companyId: ID }));
  it('names what is missing instead of falling back', () => {
    expect(() => readW6Qa({ ...full, GOLDEN_QA_W6_COMPANY_ID: '' })).toThrow(/missing: GOLDEN_QA_W6_COMPANY_ID/);
    expect(() => readW6Qa({})).toThrow(/missing: GOLDEN_QA_W6_EMAIL, GOLDEN_QA_W6_PASSWORD, GOLDEN_QA_W6_COMPANY_ID/);
  });
});

// main() against a database that is not isaflow_dev: it must stop before GoTrue, before any statement but the name check.
describe('provision-w6-qa main() refuses a non-dev database before any write', () => {
  const calls = vi.hoisted(() => ({ clients: 0, queries: [] as string[], gotrue: 0, answerDb: 'isaflow_dev' }));
  vi.mock('pg', async (importOriginal) => {
    const real = await importOriginal<{ default: Record<string, unknown> }>();
    return { ...real, default: { ...real.default, Client: class {
      constructor() { calls.clients += 1; }
      async connect() { /* no network */ }
      async query(text: string) { calls.queries.push(text); return { rows: [{ db: calls.answerDb }], rowCount: 1 }; }
      async end() { /* nothing open */ }
    } } };
  });
  vi.mock('../../../src/lib/auth/gotrue', () => ({
    adminCreateUser: async () => { calls.gotrue += 1; return { id: 'u' }; },
    adminUpdateUser: async () => { calls.gotrue += 1; },
  }));
  const GOTRUE = 'http://100.96.203.105:7770/auth/v1';
  const saved = { ...process.env };
  const run = async (dbUrl: string) => {
    Object.assign(process.env, { MIGRATION_ADMIN_DATABASE_URL: dbUrl, GOTRUE_URL: GOTRUE, SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const argv = process.argv;
    process.argv = ['bun', 'provision-w6-qa.ts', '--env-file', '/nonexistent/w6.env'];
    try { const { main } = await import('../../../scripts/ci/golden/provision-w6-qa'); await main(); } finally { process.argv = argv; }
  };
  beforeEach(() => { calls.clients = 0; calls.queries = []; calls.gotrue = 0; calls.answerDb = 'isaflow_dev'; });
  afterEach(() => { process.env = { ...saved }; });

  it('a url naming the production database never opens a connection', async () => {
    await expect(run('postgresql://dev@100.96.203.105:7772/isaflow')).rejects.toThrow(/only runs against isaflow_dev/);
    expect(calls).toMatchObject({ clients: 0, gotrue: 0 });
  });
  it('a url that says dev but a server that says otherwise stops after the name check, with nothing written', async () => {
    calls.answerDb = 'isaflow';
    await expect(run('postgresql://dev@100.96.203.105:7772/isaflow_dev')).rejects.toThrow(/not isaflow_dev; stopping before any write/);
    expect(calls.queries).toEqual(['SELECT current_database() AS db']);
    expect(calls.gotrue).toBe(0);
  });
});
