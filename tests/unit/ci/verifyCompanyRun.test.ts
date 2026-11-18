// The provisioning run's ORDER and its dry-run promise, with every effect recorded: GoTrue writes, database statements, seeding,
// the env file. A dry run writes nothing anywhere; the env keys come last; a password is saved before anything can lose it.
import { describe, expect, it } from 'vitest';
import type { ClientBase } from 'pg';
import { runProvisioning, type Deps, type RunOptions } from '../../../scripts/deploy/verifyCompany/run';
import { APPROVER_LOGIN, VERIFY_LOGIN } from '../../../scripts/deploy/verifyCompany/identity';
import type { Login } from '../../../scripts/deploy/verifyCompany/envFile';

const OPTS: RunOptions = { dryRun: false, resetPassword: false, baseUrl: 'http://app', envFile: '/x/deploy.env' };
const NOW = new Date('2026-11-18T10:00:00Z');

interface Rig { deps: Deps; log: string[]; saved: Map<string, string>; finals: Map<string, Login>; goTrue: Map<string, string> }

/** `existing`: emails already in GoTrue; `file`/`pending`: what the env file holds. */
function rig(init: { existing?: string[]; pending?: Record<string, string>; file?: Login[]; busy?: boolean; failAt?: string; problems?: string[]; seedProblems?: string[]; companyCreated?: boolean } = {}): Rig {
  const log: string[] = [];
  const saved = new Map<string, string>(Object.entries(init.pending ?? {}));
  const finals = new Map<string, Login>((init.file ?? []).map((l) => [l.email, l]));
  const goTrue = new Map<string, string>((init.existing ?? []).map((e) => [e, `id-${e}`]));
  const fail = (step: string) => { if (init.failAt === step) throw new Error(`boom at ${step}`); };
  const db = { query: async (sql: string) => { log.push(`db:${sql.split(' ')[0]}`); return { rows: [] }; } } as unknown as ClientBase;
  const deps: Deps = {
    say: (l) => { log.push(`say:${l}`); },
    now: () => NOW,
    newId: () => 'random-uuid',
    db,
    lock: { acquire: async () => { log.push('lock'); return !init.busy; }, release: async () => { log.push('unlock'); } },
    goTrue: {
      find: async (email) => { const id = goTrue.get(email); return id ? { id } : null; },
      create: async (who, password) => { log.push(`gotrue:create:${who.email}`); fail('create'); goTrue.set(who.email, `id-${who.email}`); void password; return { id: `id-${who.email}` }; },
      setPassword: async (id) => { log.push(`gotrue:setPassword:${id}`); },
    },
    env: {
      readLogin: (who) => finals.get(who.email) ?? null,
      readPending: (who) => saved.get(who.pendingKey) ?? null,
      writePending: (who, pw) => { log.push(`env:pending:${who.email}`); saved.set(who.pendingKey, pw); },
      writeLogins: (logins) => { log.push('env:final'); fail('env'); for (const { who, login } of logins) { finals.set(who.email, login); saved.delete(who.pendingKey); } return true; },
    },
    ensureDb: async (_d, ids) => { log.push(`ensureDb:${ids.verify}|${ids.approver}`); fail('db'); return { companyId: 'co-1', userCreated: true, approverCreated: true, companyCreated: init.companyCreated ?? true, approverJoined: true, periodsCreated: 36 }; },
    plan: async (_d, ctx) => { log.push(`plan:${ctx ? 'company' : 'none'}`); return [{ name: 'b1', state: 'make' }]; },
    seed: async () => { log.push('seed'); fail('seed'); return { ran: ['b1'], problems: init.seedProblems ?? [] }; },
    companyProblems: async () => { log.push('gate'); return init.problems ?? []; },
  };
  return { deps, log, saved, finals, goTrue };
}

const effects = (log: string[]) => log.filter((l) => !l.startsWith('say:'));

describe('runProvisioning', () => {
  it('runs in order: lock, GoTrue logins (each password saved at once), one transaction, seed, gate, env keys LAST, unlock', async () => {
    const r = rig();
    const out = await runProvisioning(OPTS, r.deps);
    expect(out).toEqual({ companyId: 'co-1', ran: ['b1'], wroteEnv: true });
    expect(effects(r.log)).toEqual([
      'lock',
      `env:pending:${VERIFY_LOGIN.email}`, `gotrue:create:${VERIFY_LOGIN.email}`,
      `env:pending:${APPROVER_LOGIN.email}`, `gotrue:create:${APPROVER_LOGIN.email}`,
      'db:BEGIN', `ensureDb:id-${VERIFY_LOGIN.email}|id-${APPROVER_LOGIN.email}`, 'db:COMMIT',
      'plan:company', 'seed', 'gate', 'env:final', 'unlock',
    ]);
    expect(r.saved.size).toBe(0); // the pending keys went with the final write
    expect([...r.finals.keys()].sort()).toEqual([APPROVER_LOGIN.email, VERIFY_LOGIN.email].sort());
  });

  it('--dry-run writes nothing: no GoTrue write, no commit (a rollback), no seed, no env file, and says what it would do', async () => {
    const r = rig();
    const out = await runProvisioning({ ...OPTS, dryRun: true }, r.deps);
    expect(out.wroteEnv).toBe(false);
    expect(effects(r.log)).toEqual(['lock', 'db:BEGIN', 'ensureDb:random-uuid|random-uuid', 'db:ROLLBACK', 'plan:none', 'unlock']);
    expect(r.goTrue.size).toBe(0);
    expect(r.saved.size + r.finals.size).toBe(0);
    const said = r.log.filter((l) => l.startsWith('say:')).join('\n');
    expect(said).toContain('would be created');
    expect(said).toContain('would write /x/deploy.env');
    expect(said).not.toContain(' was created');
  });

  it('--dry-run on a provisioned company plans against it, with the real ids, and still writes nothing', async () => {
    const r = rig({ existing: [VERIFY_LOGIN.email, APPROVER_LOGIN.email], file: [{ email: VERIFY_LOGIN.email, password: 'a' }, { email: APPROVER_LOGIN.email, password: 'b' }], companyCreated: false });
    await runProvisioning({ ...OPTS, dryRun: true }, r.deps);
    expect(effects(r.log)).toEqual(['lock', 'db:BEGIN', `ensureDb:id-${VERIFY_LOGIN.email}|id-${APPROVER_LOGIN.email}`, 'db:ROLLBACK', 'plan:company', 'unlock']);
  });

  it('a run that dies after creating the logins leaves their passwords in the file, so a plain re-run resumes it', async () => {
    const first = rig({ failAt: 'db' });
    await expect(runProvisioning(OPTS, first.deps)).rejects.toThrow(/boom at db/);
    expect(effects(first.log)).toContain('db:ROLLBACK');
    expect(effects(first.log)).not.toContain('seed');
    expect(first.saved.size).toBe(2);
    expect(first.finals.size).toBe(0); // verify-deploy.sh would still see no login
    expect(first.log.at(-1)).toBe('unlock');

    // The same state, the logins in GoTrue, the passwords pending: no --reset-password needed.
    const again = rig({ existing: [VERIFY_LOGIN.email, APPROVER_LOGIN.email], pending: Object.fromEntries(first.saved) });
    await expect(runProvisioning(OPTS, again.deps)).resolves.toMatchObject({ wroteEnv: true });
    expect(effects(again.log)).toContain(`gotrue:setPassword:id-${VERIFY_LOGIN.email}`); // GoTrue is given the saved one again
    expect(again.saved.size).toBe(0);
  });

  it('the password is saved BEFORE GoTrue is asked to change it (--reset-password on a login that exists)', async () => {
    const r = rig({ existing: [VERIFY_LOGIN.email, APPROVER_LOGIN.email] });
    await runProvisioning({ ...OPTS, resetPassword: true }, r.deps);
    const e = effects(r.log);
    expect(e.indexOf(`env:pending:${VERIFY_LOGIN.email}`)).toBeLessThan(e.indexOf(`gotrue:setPassword:id-${VERIFY_LOGIN.email}`));
    expect(e.indexOf(`env:pending:${APPROVER_LOGIN.email}`)).toBeLessThan(e.indexOf(`gotrue:setPassword:id-${APPROVER_LOGIN.email}`));
  });

  it('without --reset-password a login that exists and has no saved password is refused before anything is written', async () => {
    const r = rig({ existing: [VERIFY_LOGIN.email, APPROVER_LOGIN.email] });
    await expect(runProvisioning(OPTS, r.deps)).rejects.toThrow(/--reset-password/);
    expect(effects(r.log)).toEqual(['lock', 'unlock']);
  });

  it('an unusable company (the gate) or a seed shortfall stops before the env keys: a deploy never reads a half-made company', async () => {
    const gate = rig({ problems: ['no bank account'] });
    await expect(runProvisioning(OPTS, gate.deps)).rejects.toThrow(/not usable: no bank account/);
    expect(effects(gate.log)).not.toContain('env:final');
    expect(gate.finals.size).toBe(0);

    const budget = rig({ seedProblems: ['no budget version for FY2027'] });
    await expect(runProvisioning(OPTS, budget.deps)).rejects.toThrow(/no budget version for FY2027/);
    expect(effects(budget.log)).not.toContain('env:final');
  });

  it('a failed seed stops before the gate and the env keys; the pending passwords stay', async () => {
    const r = rig({ failAt: 'seed' });
    await expect(runProvisioning(OPTS, r.deps)).rejects.toThrow(/boom at seed/);
    expect(effects(r.log)).not.toContain('gate');
    expect(effects(r.log)).not.toContain('env:final');
    expect(r.saved.size).toBe(2);
  });

  it('refuses while another run holds the lock, touching nothing, and does not release a lock it never took', async () => {
    const r = rig({ busy: true });
    await expect(runProvisioning(OPTS, r.deps)).rejects.toThrow(/another provisioning run holds the lock/);
    expect(effects(r.log)).toEqual(['lock']);
  });

  it('releases the lock when the run fails', async () => {
    const r = rig({ failAt: 'create' });
    await expect(runProvisioning(OPTS, r.deps)).rejects.toThrow();
    expect(r.log.at(-1)).toBe('unlock');
  });

  it('never says a password', async () => {
    const r = rig();
    await runProvisioning(OPTS, r.deps);
    const said = r.log.filter((l) => l.startsWith('say:')).join('\n');
    for (const pw of [...r.saved.values(), ...[...r.finals.values()].map((l) => l.password)]) expect(said).not.toContain(pw);
  });
});

