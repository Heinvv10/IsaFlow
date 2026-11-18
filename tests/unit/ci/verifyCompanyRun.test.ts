// The provisioning run's ORDER and its dry-run promise, with every effect recorded: GoTrue writes, database statements, seeding,
// the env file. A dry run writes nothing anywhere; the env keys come last; a password is saved before anything can lose it.
import { describe, expect, it } from 'vitest';
import type { ClientBase } from 'pg';
import { runProvisioning, type Deps, type RunOptions } from '../../../scripts/deploy/verifyCompany/run';
import { APPROVER_LOGIN, LOGIN_PURPOSE, VERIFY_LOGIN } from '../../../scripts/deploy/verifyCompany/identity';
import type { Login } from '../../../scripts/deploy/verifyCompany/envFile';

const OPTS: RunOptions = { dryRun: false, resetPassword: false, baseUrl: 'http://app', envFile: '/x/deploy.env' };
const NOW = new Date('2026-11-18T10:00:00Z');

interface Rig { deps: Deps; log: string[]; ids?: Map<string, string>; saved: Map<string, string>; finals: Map<string, Login>; goTrue: Map<string, string> }

/** `existing`: emails already in GoTrue; `file`/`pending`: what the env file holds. */
function rig(init: { existing?: string[]; foreign?: string[]; legacy?: string[]; legacyIds?: Record<string, string>; signOutFailsOnce?: boolean; approverActual?: string; pending?: Record<string, string>; file?: Login[]; busy?: boolean; deployBusy?: boolean; failAt?: string; problems?: string[]; seedProblems?: string[]; companyCreated?: boolean; rollbackFails?: boolean; unlockFails?: boolean; createdForeign?: boolean } = {}): Rig {
  const log: string[] = [];
  const saved = new Map<string, string>(Object.entries(init.pending ?? {}));
  const finals = new Map<string, Login>((init.file ?? []).map((l) => [l.email, l]));
  const goTrue = new Map<string, string>([...(init.existing ?? []), ...(init.foreign ?? []), ...(init.legacy ?? [])].map((e) => [e, `id-${e}`]));
  const foreign = new Set(init.foreign ?? []);
  const legacy = new Set(init.legacy ?? []);
  const ids = new Map<string, string>(Object.entries(init.legacyIds ?? {}));
  let signOutFailed = false;
  const fail = (step: string) => { if (init.failAt === step) throw new Error(`boom at ${step}`); };
  const db = { query: async (sql: string) => { log.push(`db:${sql.split(' ')[0]}`); if (sql === 'ROLLBACK' && init.rollbackFails) throw new Error('rollback socket closed'); return { rows: [] }; } } as unknown as ClientBase;
  const deps: Deps = {
    say: (l) => { log.push(`say:${l}`); },
    now: () => NOW,
    newId: () => 'random-uuid',
    db,
    lock: { acquire: async () => { log.push('lock'); return !init.busy; }, release: async () => { log.push('unlock'); if (init.unlockFails) throw new Error('connection gone'); } },
    deployLocks: {
      acquire: async () => {
        log.push('deploylocks');
        if (init.deployBusy) throw new Error('a deploy, rollback, restart or cutover holds /tmp/isaflow-deploy.lock');
        return { release: async () => { log.push('deploy-unlock'); } };
      },
    },
    goTrue: {
      find: async (email) => { const id = goTrue.get(email); return id ? { id, purpose: foreign.has(email) ? 'someone elses' : legacy.has(email) ? null : LOGIN_PURPOSE, legacyPurpose: legacy.has(email) ? LOGIN_PURPOSE : null } : null; },
      stamp: async (id) => { log.push(`gotrue:stamp:${id}`); legacy.delete([...goTrue].find(([, v]) => v === id)![0]); },
      create: async (who, password) => { log.push(`gotrue:create:${who.email}`); fail('create'); goTrue.set(who.email, `id-${who.email}`); void password; return { id: `id-${who.email}`, purpose: init.createdForeign ? null : LOGIN_PURPOSE }; },
      setPassword: async (id) => { log.push(`gotrue:setPassword:${id}`); },
      signOut: async (id) => { log.push(`gotrue:signOut:${id}`); if (init.signOutFailsOnce && !signOutFailed) { signOutFailed = true; throw new Error('gotrue unreachable'); } },
    },
    env: {
      readLogin: (who) => finals.get(who.email) ?? null,
      readPending: (who) => saved.get(who.pendingKey) ?? null,
      readId: (who) => ids.get(who.idKey) ?? null,
      recordId: (who, id) => { log.push(`env:id:${who.email}`); ids.set(who.idKey, id); },
      writePending: (who, pw) => { log.push(`env:pending:${who.email}`); saved.set(who.pendingKey, pw); },
      writeLogins: (logins) => { log.push('env:final'); fail('env'); for (const { who, login, id } of logins) { finals.set(who.email, login); saved.delete(who.pendingKey); if (id) ids.set(who.idKey, id); } return true; },
    },
    ensureDb: async (_d, ids) => { log.push(`ensureDb:${ids.verify}|${ids.approver}`); fail('db'); return { companyId: 'co-1', userCreated: true, approverCreated: true, companyCreated: init.companyCreated ?? true, approverJoined: true, approverRole: 'manager', approverActualRole: init.approverActual ?? 'manager', financialYearStart: 3, periodsCreated: 36 }; },
    plan: async (_d, ctx) => { log.push(`plan:${ctx ? 'company' : 'none'}`); return [{ name: 'b1', state: 'make' }]; },
    seed: async () => { log.push('seed'); fail('seed'); return { ran: ['b1'], problems: init.seedProblems ?? [] }; },
    companyProblems: async () => { log.push('gate'); return init.problems ?? []; },
  };
  return { deps, log, saved, finals, goTrue, ids };
}

const effects = (log: string[]) => log.filter((l) => !l.startsWith('say:'));

describe('runProvisioning, review round 2', () => {
  it('refuses a real run while a deploy holds a lock: nothing is written, no run lock is taken', async () => {
    const r = rig({ deployBusy: true });
    await expect(runProvisioning(OPTS, r.deps)).rejects.toThrow(/holds \/tmp\/isaflow-deploy\.lock/);
    expect(effects(r.log)).toEqual(['deploylocks']);
    expect(r.saved.size + r.finals.size + r.goTrue.size).toBe(0);
  });

  it('a dry run is not refused by a deploy lock (it takes none)', async () => {
    await expect(runProvisioning({ ...OPTS, dryRun: true }, rig({ deployBusy: true }).deps)).resolves.toMatchObject({ wroteEnv: false });
  });

  it.each([[false], [true]])('never adopts a GoTrue login it did not create (reset-password %s): refused before any write', async (reset) => {
    const r = rig({ foreign: [VERIFY_LOGIN.email], existing: [APPROVER_LOGIN.email], pending: {} });
    await expect(runProvisioning({ ...OPTS, resetPassword: reset }, r.deps)).rejects.toThrow(/not created by this provisioner.*refusing to adopt/s);
    expect(effects(r.log).filter((e) => e.startsWith('gotrue:') || e.startsWith('env:') || e.startsWith('db:') || e === 'seed')).toEqual([]);
    expect(r.log.slice(-2)).toEqual(['unlock', 'deploy-unlock']);
  });

  it('adoption is refused for the approver too', async () => {
    const r = rig({ existing: [VERIFY_LOGIN.email], foreign: [APPROVER_LOGIN.email], file: [{ email: VERIFY_LOGIN.email, password: 'a' }] });
    await expect(runProvisioning(OPTS, r.deps)).rejects.toThrow(/deploy-verify-approver@isaflow\.co\.za.*not created by this provisioner/s);
  });

  it('a create that answers with a login that is not ours (made in the meantime) is refused', async () => {
    await expect(runProvisioning(OPTS, rig({ createdForeign: true }).deps)).rejects.toThrow(/made in the meantime/);
  });

  it('--reset-password ends the login\'s sessions after setting the new password; so does a resume (the run it resumes may have died before the sign-out); a plain run with nothing pending does not', async () => {
    const reset = rig({ existing: [VERIFY_LOGIN.email, APPROVER_LOGIN.email] });
    await runProvisioning({ ...OPTS, resetPassword: true }, reset.deps);
    const e = effects(reset.log);
    for (const w of [VERIFY_LOGIN, APPROVER_LOGIN]) {
      expect(e.indexOf(`gotrue:setPassword:id-${w.email}`)).toBeGreaterThan(-1);
      expect(e.indexOf(`gotrue:signOut:id-${w.email}`)).toBeGreaterThan(e.indexOf(`gotrue:setPassword:id-${w.email}`));
    }
    const resumed = rig({ existing: [VERIFY_LOGIN.email, APPROVER_LOGIN.email], pending: { [VERIFY_LOGIN.pendingKey]: 'p1', [APPROVER_LOGIN.pendingKey]: 'p2' } });
    await runProvisioning(OPTS, resumed.deps);
    const re = effects(resumed.log);
    for (const w of [VERIFY_LOGIN, APPROVER_LOGIN]) expect(re.indexOf(`gotrue:signOut:id-${w.email}`)).toBeGreaterThan(re.indexOf(`gotrue:setPassword:id-${w.email}`));
    const plain = rig({ existing: [VERIFY_LOGIN.email, APPROVER_LOGIN.email], file: [{ email: VERIFY_LOGIN.email, password: 'a' }, { email: APPROVER_LOGIN.email, password: 'b' }] });
    await runProvisioning(OPTS, plain.deps);
    expect(effects(plain.log).some((x) => x.startsWith('gotrue:signOut') || x.startsWith('gotrue:setPassword'))).toBe(false);
  });

  it('a reset whose sign-out failed is finished by the plain re-run: the saved password is set again and the sessions ended', async () => {
    const first = rig({ existing: [VERIFY_LOGIN.email, APPROVER_LOGIN.email], signOutFailsOnce: true });
    await expect(runProvisioning({ ...OPTS, resetPassword: true }, first.deps)).rejects.toThrow(/gotrue unreachable/);
    expect(first.saved.size).toBe(1); // the verify login's new password is still pending (the approver was never reached)
    const again = rig({ existing: [VERIFY_LOGIN.email, APPROVER_LOGIN.email], pending: Object.fromEntries(first.saved), file: [{ email: APPROVER_LOGIN.email, password: 'b' }] });
    await runProvisioning(OPTS, again.deps); // no --reset-password
    const e = effects(again.log);
    expect(e).toContain(`gotrue:setPassword:id-${VERIFY_LOGIN.email}`);
    expect(e.indexOf(`gotrue:signOut:id-${VERIFY_LOGIN.email}`)).toBeGreaterThan(e.indexOf(`gotrue:setPassword:id-${VERIFY_LOGIN.email}`));
    expect(again.saved.size).toBe(0);
  });

  it('the admin-only marker proves a login ours; a user_metadata one (earlier version) only when its GoTrue id is recorded in the env file', async () => {
    const recorded = rig({ legacy: [VERIFY_LOGIN.email], existing: [APPROVER_LOGIN.email], legacyIds: { [VERIFY_LOGIN.idKey]: `id-${VERIFY_LOGIN.email}` }, file: [{ email: VERIFY_LOGIN.email, password: 'a' }, { email: APPROVER_LOGIN.email, password: 'b' }] });
    await runProvisioning(OPTS, recorded.deps);
    expect(effects(recorded.log)).toContain(`gotrue:stamp:id-${VERIFY_LOGIN.email}`); // migrated to app_metadata
    const stranger = rig({ legacy: [VERIFY_LOGIN.email], existing: [APPROVER_LOGIN.email], legacyIds: { [VERIFY_LOGIN.idKey]: 'some-other-id' } });
    await expect(runProvisioning(OPTS, stranger.deps)).rejects.toThrow(/not created by this provisioner/);
    const unrecorded = rig({ legacy: [VERIFY_LOGIN.email], existing: [APPROVER_LOGIN.email] });
    await expect(runProvisioning({ ...OPTS, resetPassword: true }, unrecorded.deps)).rejects.toThrow(/refusing to adopt/);
    expect(effects(unrecorded.log).filter((x) => x.startsWith('gotrue:'))).toEqual([]);
  });

  it('records each new login\'s GoTrue id right after the create, and publishes the ids with the final keys', async () => {
    const r = rig();
    await runProvisioning(OPTS, r.deps);
    const e = effects(r.log);
    expect(e.indexOf(`env:id:${VERIFY_LOGIN.email}`)).toBe(e.indexOf(`gotrue:create:${VERIFY_LOGIN.email}`) + 1);
    expect(r.finals.size).toBe(2);
    expect(r.ids?.get(VERIFY_LOGIN.idKey)).toBe(`id-${VERIFY_LOGIN.email}`);
    expect(r.ids?.get(APPROVER_LOGIN.idKey)).toBe(`id-${APPROVER_LOGIN.email}`);
  });

  it('says the approver\'s ACTUAL role, and warns when an existing membership is above the least role that can decide', async () => {
    const said = (r: Rig) => r.log.filter((l) => l.startsWith('say:')).join('\n');
    const ok = rig();
    await runProvisioning(OPTS, ok.deps);
    expect(said(ok)).toContain('approver added as manager');
    expect(said(ok)).not.toContain('warning: the approver');
    const above = rig({ approverActual: 'admin' });
    await runProvisioning(OPTS, above.deps);
    expect(said(above)).toContain('added as admin');
    expect(said(above)).toMatch(/warning: the approver's existing membership is admin, above the least role .*\(manager\).*lower it by hand/);
  });

  it('a failed ROLLBACK does not hide the error that caused it', async () => {
    const r = rig({ failAt: 'db', rollbackFails: true });
    await expect(runProvisioning(OPTS, r.deps)).rejects.toThrow(/boom at db/);
  });

  it('a lock release that fails does not replace the run\'s error, nor turn a success into a failure', async () => {
    await expect(runProvisioning(OPTS, rig({ failAt: 'seed', unlockFails: true }).deps)).rejects.toThrow(/boom at seed/);
    const ok = rig({ unlockFails: true });
    await expect(runProvisioning(OPTS, ok.deps)).resolves.toMatchObject({ wroteEnv: true });
    expect(ok.log.some((l) => l.includes('warning: releasing the run lock failed: connection gone'))).toBe(true);
  });
});

describe('runProvisioning', () => {
  it('runs in order: deploy locks, run lock, GoTrue logins (each password saved at once), one transaction, seed, gate, env keys LAST, unlock both', async () => {
    const r = rig();
    const out = await runProvisioning(OPTS, r.deps);
    expect(out).toEqual({ companyId: 'co-1', ran: ['b1'], wroteEnv: true });
    expect(effects(r.log)).toEqual([
      'deploylocks', 'lock',
      `env:pending:${VERIFY_LOGIN.email}`, `gotrue:create:${VERIFY_LOGIN.email}`, `env:id:${VERIFY_LOGIN.email}`,
      `env:pending:${APPROVER_LOGIN.email}`, `gotrue:create:${APPROVER_LOGIN.email}`, `env:id:${APPROVER_LOGIN.email}`,
      'db:BEGIN', `ensureDb:id-${VERIFY_LOGIN.email}|id-${APPROVER_LOGIN.email}`, 'db:COMMIT',
      'plan:company', 'seed', 'gate', 'env:final', 'unlock', 'deploy-unlock',
    ]);
    expect(r.saved.size).toBe(0); // the pending keys went with the final write
    expect([...r.finals.keys()].sort()).toEqual([APPROVER_LOGIN.email, VERIFY_LOGIN.email].sort());
  });

  it('--dry-run writes nothing: no GoTrue write, no commit (a rollback), no seed, no env file, and says what it would do', async () => {
    const r = rig();
    const out = await runProvisioning({ ...OPTS, dryRun: true }, r.deps);
    expect(out.wroteEnv).toBe(false);
    expect(effects(r.log)).toEqual(['lock', 'db:BEGIN', 'ensureDb:random-uuid|random-uuid', 'db:ROLLBACK', 'plan:none', 'unlock']); // no deploy locks: a dry run changes nothing
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
    expect(first.log.slice(-2)).toEqual(['unlock', 'deploy-unlock']);

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
    expect(effects(r.log)).toEqual(['deploylocks', 'lock', 'unlock', 'deploy-unlock']);
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
    expect(effects(r.log)).toEqual(['deploylocks', 'lock', 'deploy-unlock']);
  });

  it('releases the lock when the run fails', async () => {
    const r = rig({ failAt: 'create' });
    await expect(runProvisioning(OPTS, r.deps)).rejects.toThrow();
    expect(r.log.slice(-2)).toEqual(['unlock', 'deploy-unlock']);
  });

  it('never says a password', async () => {
    const r = rig();
    await runProvisioning(OPTS, r.deps);
    const said = r.log.filter((l) => l.startsWith('say:')).join('\n');
    for (const pw of [...r.saved.values(), ...[...r.finals.values()].map((l) => l.password)]) expect(said).not.toContain(pw);
  });
});

