// migrate-slot-emails.ts against a stateful fake of isaflow_dev and GoTrue: what it writes, in what order, what it refuses.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../../../scripts/ci/golden/migrate-slot-emails';
import { applyPlan, findUnknownLegacy, readAccountState, type Db, type GoTrueOps } from '../../../scripts/ci/golden/slotEmailApply';
import { knownAccounts, planAccount } from '../../../scripts/ci/golden/slotEmailPlan';
import { EXPECTED_GOTRUE_URL, slotCompanyId } from '../../../scripts/ci/golden/slotConfig';

interface World {
  dbName: string;
  gotrue: Map<string, string>; // id -> email
  users: Map<string, string>;
  companies: Array<{ id: string; email: string }>;
  log: string[];
  failGoTrue?: boolean;
  failCommit?: boolean;
}
const newWorld = (): World => ({
  dbName: 'isaflow_dev', log: [],
  gotrue: new Map([['g1', 'golden-slot-1@isaflow.dev'], ['g2', 'golden-slot-2@isaflow.dev'], ['gw', 'golden-qa-w6@isaflow.dev'], ['gx', 'stranger@isaflow.dev'], ['ga', 'admin@isaflow.co.za']]),
  users: new Map([['g1', 'golden-slot-1@isaflow.dev'], ['g2', 'golden-slot-2@isaflow.dev'], ['gw', 'golden-qa-w6@isaflow.dev'], ['ux', 'orphan@isaflow.dev']]),
  companies: [{ id: slotCompanyId(1), email: 'golden-slot-1@isaflow.dev' }, { id: slotCompanyId(2), email: 'golden-slot-2@isaflow.dev' }, { id: '11111111-0000-4000-8000-000000000001', email: 'golden-slot-1@isaflow.dev' }],
});

function fakes(w: World): { db: Db & { end(): Promise<void> }; gt: GoTrueOps } {
  let snapshot: { users: Map<string, string>; companies: World['companies'] } | null = null;
  const db = {
    end: async () => { w.log.push('end'); },
    query: async (sql: string, p: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      const rows = (r: unknown[]) => ({ rows: r as never[], rowCount: r.length });
      if (/^SELECT current_database/.test(s)) return rows([{ db: w.dbName }]);
      if (s === 'BEGIN') { snapshot = { users: new Map(w.users), companies: w.companies.map((c) => ({ ...c })) }; w.log.push('BEGIN'); return rows([]); }
      if (s === 'COMMIT') { if (w.failCommit) throw new Error('commit failed'); snapshot = null; w.log.push('COMMIT'); return rows([]); }
      if (s === 'ROLLBACK') { if (snapshot) { w.users = snapshot.users; w.companies = snapshot.companies; } w.log.push('ROLLBACK'); return rows([]); }
      if (/^SELECT id::text AS id FROM users/.test(s)) return rows([...w.users].filter(([, e]) => e.toLowerCase() === String(p[0]).toLowerCase()).map(([id]) => ({ id })));
      if (/^SELECT count\(\*\)::int AS n FROM companies/.test(s)) return rows([{ n: w.companies.filter((c) => c.email.toLowerCase() === String(p[0]).toLowerCase() && /^601d000/.test(c.id)).length }]);
      if (/^SELECT email FROM users/.test(s)) return rows([...w.users.values()].filter((e) => e.endsWith(String(p[0]))).map((email) => ({ email })));
      if (/^UPDATE users SET email/.test(s)) { w.log.push('UPDATE users'); for (const [id, e] of w.users) if (id === p[0] && e.toLowerCase() === String(p[2]).toLowerCase()) w.users.set(id, String(p[1])); return rows([]); }
      if (/^UPDATE companies SET email/.test(s)) { w.log.push('UPDATE companies'); for (const c of w.companies) if (c.email.toLowerCase() === String(p[1]).toLowerCase() && /^601d000/.test(c.id)) c.email = String(p[0]); return rows([]); }
      throw new Error(`unexpected SQL: ${s}`);
    },
  };
  const gt: GoTrueOps = {
    find: async (email) => { const e = [...w.gotrue].find(([, v]) => v.toLowerCase() === email.toLowerCase()); return e ? { id: e[0], email: e[1] } : null; },
    list: async (f) => [...w.gotrue].filter(([, v]) => v.includes(f)).map(([id, email]) => ({ id, email })),
    setEmail: async (id, email) => { w.log.push('GOTRUE'); if (w.failGoTrue) throw new Error('gotrue down'); w.gotrue.set(id, email); },
  };
  return { db, gt };
}

describe('applyPlan', () => {
  it('updates users and companies, then GoTrue, then commits; the id never changes', async () => {
    const w = newWorld(); const { db, gt } = fakes(w);
    const a = knownAccounts()[0]!;
    await applyPlan(db, gt, planAccount(a, await readAccountState(db, gt, a)));
    expect(w.log).toEqual(['BEGIN', 'UPDATE users', 'UPDATE companies', 'GOTRUE', 'COMMIT']);
    expect(w.gotrue.get('g1')).toBe('golden-slot-1@isaflow.co.za');
    expect(w.users.get('g1')).toBe('golden-slot-1@isaflow.co.za');
    // Only the slot company moved: a company outside the slot id pattern that carries the address is not ours to rewrite.
    expect(w.companies.map((c) => c.email)).toEqual(['golden-slot-1@isaflow.co.za', 'golden-slot-2@isaflow.dev', 'golden-slot-1@isaflow.dev']);
  });

  it('rolls the database back when GoTrue fails, and a re-run then migrates', async () => {
    const w = newWorld(); const { db, gt } = fakes(w);
    const a = knownAccounts()[0]!;
    w.failGoTrue = true;
    await expect(applyPlan(db, gt, planAccount(a, await readAccountState(db, gt, a)))).rejects.toThrow(/gotrue down/);
    expect(w.log).toContain('ROLLBACK');
    expect(w.users.get('g1')).toBe('golden-slot-1@isaflow.dev');
    expect(w.companies[0]!.email).toBe('golden-slot-1@isaflow.dev');
    w.failGoTrue = false;
    await applyPlan(db, gt, planAccount(a, await readAccountState(db, gt, a)));
    expect(w.gotrue.get('g1')).toBe('golden-slot-1@isaflow.co.za');
  });

  it('heals a COMMIT that failed after GoTrue changed: only the database steps remain', async () => {
    const w = newWorld(); const { db, gt } = fakes(w);
    const a = knownAccounts()[0]!;
    w.failCommit = true;
    await expect(applyPlan(db, gt, planAccount(a, await readAccountState(db, gt, a)))).rejects.toThrow(/commit failed/);
    w.failCommit = false;
    expect(w.gotrue.get('g1')).toBe('golden-slot-1@isaflow.co.za');
    const again = planAccount(a, await readAccountState(db, gt, a));
    expect(again.steps).toEqual(['users-email', 'companies-email']);
    await applyPlan(db, gt, again);
    expect(planAccount(a, await readAccountState(db, gt, a)).action).toBe('noop');
  });

  it('writes nothing for a no-op or a conflict plan', async () => {
    const w = newWorld(); const { db, gt } = fakes(w);
    const a = knownAccounts()[0]!;
    await applyPlan(db, gt, planAccount(a, { gotrueOld: null, gotrueNew: 'g1', usersOld: [], usersNew: ['g1'], companiesOld: 0 }));
    await applyPlan(db, gt, planAccount(a, { gotrueOld: 'g1', gotrueNew: 'g9', usersOld: [], usersNew: [], companiesOld: 0 }));
    expect(w.log).toEqual([]);
  });
});

describe('findUnknownLegacy', () => {
  it('lists old-domain addresses no code knows, in GoTrue and in users, and leaves known ones out', async () => {
    const w = newWorld(); const { db, gt } = fakes(w);
    expect(await findUnknownLegacy(db, gt, knownAccounts())).toEqual({ gotrue: ['stranger@isaflow.dev'], users: ['orphan@isaflow.dev'] });
  });
});

describe('main', () => {
  let dir: string; let ciEnv: string; let w6Env: string; let w: World; let said: string[];
  const KEY_MARKER = 'service-key-value-9f3a';
  const io = (world: World, over: Partial<Io> = {}, connected: string[] = []): Io => {
    const f = fakes(world);
    return {
      processEnv: {}, say: (l) => said.push(l),
      connect: async (u) => { connected.push(u); return f.db; },
      useGoTrue: () => f.gt, ...over,
    };
  };
  const envText = (over: Record<string, string> = {}): string => Object.entries({
    DATABASE_URL: 'postgresql://u@h:7772/isaflow_dev', GOTRUE_URL: EXPECTED_GOTRUE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY_MARKER,
    GOLDEN_SLOT_1_EMAIL: 'golden-slot-1@isaflow.dev', GOLDEN_SLOT_1_PASSWORD: 'pw1', E2E_ADMIN_EMAIL: 'reporting-qa@isaflow.dev', ...over,
  }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const run = (extra: string[] = [], world = w, over: Partial<Io> = {}, connected: string[] = []) => main(['--env-file', ciEnv, '--w6-env-file', w6Env, ...extra], io(world, over, connected));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slot-email-')); ciEnv = join(dir, 'ci.env'); w6Env = join(dir, 'w6.env'); w = newWorld(); said = [];
    writeFileSync(ciEnv, envText(), { mode: 0o600 });
    writeFileSync(w6Env, 'GOLDEN_QA_W6_EMAIL=golden-qa-w6@isaflow.dev\nGOLDEN_QA_W6_PASSWORD=w6pw\n', { mode: 0o600 });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('--dry-run prints the plan and the unknown accounts and writes nothing anywhere', async () => {
    const before = readFileSync(ciEnv, 'utf8');
    expect(await run(['--dry-run'])).toBe(0);
    expect(w.log).toEqual(['end']);
    expect(w.gotrue.get('g1')).toBe('golden-slot-1@isaflow.dev');
    expect(readFileSync(ciEnv, 'utf8')).toBe(before);
    const out = said.join('\n');
    expect(out).toContain('slot 1: golden-slot-1@isaflow.dev -> golden-slot-1@isaflow.co.za');
    expect(out).toContain('UNKNOWN GoTrue account on the old domain, untouched: stranger@isaflow.dev');
    expect(out).toContain('would rewrite GOLDEN_SLOT_1_EMAIL, E2E_ADMIN_EMAIL');
    expect(out).not.toContain(KEY_MARKER);
    expect(out).not.toContain('pw1');
  });

  it('migrates, rewrites the env keys, keeps the mode, never prints a value, and a second run is a no-op', async () => {
    expect(await run()).toBe(0);
    expect(w.gotrue.get('g1')).toBe('golden-slot-1@isaflow.co.za');
    expect(w.gotrue.get('g2')).toBe('golden-slot-2@isaflow.co.za');
    expect(w.gotrue.get('gw')).toBe('golden-qa-w6@isaflow.co.za');
    expect(w.gotrue.get('gx')).toBe('stranger@isaflow.dev');
    expect(w.users.get('ux')).toBe('orphan@isaflow.dev');
    const ci = readFileSync(ciEnv, 'utf8');
    expect(ci).toContain('GOLDEN_SLOT_1_EMAIL=golden-slot-1@isaflow.co.za\n');
    expect(ci).toContain('E2E_ADMIN_EMAIL=reporting-qa@isaflow.co.za\n');
    expect(ci).toContain(`SUPABASE_SERVICE_ROLE_KEY=${KEY_MARKER}\n`);
    expect(readFileSync(w6Env, 'utf8')).toBe('GOLDEN_QA_W6_EMAIL=golden-qa-w6@isaflow.co.za\nGOLDEN_QA_W6_PASSWORD=w6pw\n');
    expect(statSync(ciEnv).mode & 0o777).toBe(0o600);
    expect(statSync(w6Env).mode & 0o777).toBe(0o600);
    expect(said.join('\n')).not.toContain(KEY_MARKER);
    const writesAfterFirst = w.log.length; const snapshot = readFileSync(ciEnv, 'utf8'); said = [];
    expect(await run()).toBe(0);
    expect(w.log.length).toBe(writesAfterFirst + 1); // only the connection's end
    expect(readFileSync(ciEnv, 'utf8')).toBe(snapshot);
    expect(said.join('\n')).toMatch(/slot 1: .*nothing to do/);
  });

  it('refuses the whole run on a conflict, before any write', async () => {
    w.gotrue.set('gdup', 'golden-slot-2@isaflow.co.za');
    expect(await run()).toBe(1);
    expect(w.log).toEqual(['end']);
    expect(w.gotrue.get('g1')).toBe('golden-slot-1@isaflow.dev');
    expect(readFileSync(ciEnv, 'utf8')).toContain('GOLDEN_SLOT_1_EMAIL=golden-slot-1@isaflow.dev');
    expect(said.join('\n')).toMatch(/REFUSED/);
  });

  it.each([
    ['production on the same host (url path)', { DATABASE_URL: 'postgresql://u@h:7772/isaflow' }, /isaflow_dev/],
    ['a database named in the query string', { DATABASE_URL: 'postgresql://u@h:7772/isaflow_dev?dbname=isaflow' }, /query string/],
    ['another GoTrue instance', { GOTRUE_URL: 'http://127.0.0.1:9999/auth/v1' }, /GOTRUE_URL/],
  ])('refuses %s before connecting', async (_l, env, re) => {
    writeFileSync(ciEnv, envText(env), { mode: 0o600 });
    const connected: string[] = [];
    await expect(run(['--dry-run'], w, {}, connected)).rejects.toThrow(re);
    await expect(run([], w, {}, connected)).rejects.toThrow(re);
    expect(connected).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it('refuses when the server says it is not isaflow_dev, before any write (the real guard)', async () => {
    w.dbName = 'isaflow';
    await expect(run()).rejects.toThrow(/not isaflow_dev/);
    expect(w.log).toEqual(['end']);
    expect(w.gotrue.get('g1')).toBe('golden-slot-1@isaflow.dev');
  });

  it('refuses without the GoTrue service key', async () => {
    writeFileSync(ciEnv, envText({ SUPABASE_SERVICE_ROLE_KEY: '' }), { mode: 0o600 });
    await expect(run()).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
