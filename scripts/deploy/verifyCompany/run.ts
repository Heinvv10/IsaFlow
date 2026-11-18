/**
 * The provisioning run, in order, with everything it touches passed in (so the order and the dry-run promise are tested,
 * not just read). scripts/deploy/provision-verify-company.ts wires the real GoTrue, database, app and env file.
 *
 *   0. the deploy locks (a real run only: refused while a deploy, rollback or restart runs), then the database run lock (one run at a time);
 *   1. GoTrue, per login: look it up; a new login's password is saved to the env file's PENDING key straight after the create
 *      (and before any password change of an existing one), so a run that dies later is re-run plainly, never with --reset-password;
 *   2. the database, one transaction (users, company, approver membership, fiscal years), rolled back by --dry-run;
 *   3. the running app seeds the blocks as the verify login;
 *   4. the readiness gate; then, LAST, the logins' keys (and the pending keys' removal), so a deploy never reads a half-made company.
 * --dry-run writes nothing anywhere: no GoTrue write, no commit, no seed, no env file.
 */
import type { ClientBase } from 'pg';
import type { Login } from './envFile';
import { APPROVER_LOGIN, LOGIN_PURPOSE, VERIFY_LOGIN, type LoginIdentity } from './identity';
import { choosePassword } from './password';
import { rollbackFailed } from '../../../src/lib/rollbackFailed';
import type { DbOutcome, UserIds } from './provisionDb';
import type { PlanLine } from './seedVerifyCompany';

export interface RunOptions { dryRun: boolean; resetPassword: boolean; baseUrl: string; envFile: string }

export interface Deps {
  say(line: string): void;
  now(): Date;
  newId(): string;
  db: ClientBase;
  lock: { acquire(db: ClientBase): Promise<boolean>; release(db: ClientBase): Promise<void> };
  /** The deploy locks (deployLock.ts), taken for a real run only: rejects when a deploy holds one. */
  deployLocks: { acquire(): Promise<{ release(): Promise<void> }> };
  goTrue: {
    /** `purpose`: the login's user_metadata.purpose, which marks one this provisioner created. */
    find(email: string): Promise<{ id: string; purpose: string | null } | null>;
    create(who: LoginIdentity, password: string): Promise<{ id: string; purpose: string | null }>;
    setPassword(id: string, password: string): Promise<void>;
    /** Revokes every refresh token of the login (GoTrue's global logout). */
    signOut(id: string, email: string): Promise<void>;
  };
  env: {
    readLogin(who: LoginIdentity): Login | null;
    readPending(who: LoginIdentity): string | null;
    writePending(who: LoginIdentity, password: string): void;
    writeLogins(logins: Array<{ who: LoginIdentity; login: Login }>): boolean;
  };
  ensureDb(db: ClientBase, ids: UserIds, today: Date): Promise<DbOutcome>;
  plan(db: ClientBase, ctx: { companyId: string; verifyUserId: string; now: Date } | null): Promise<PlanLine[]>;
  seed(db: ClientBase, o: { companyId: string; verifyUserId: string; password: string; now: Date }): Promise<{ ran: string[]; problems: string[] }>;
  companyProblems(db: ClientBase, companyId: string, ids: UserIds): Promise<string[]>;
}

export interface RunResult { companyId: string; ran: string[]; wroteEnv: boolean }

interface Resolved { id: string; password: string }

async function ensureLogin(o: RunOptions, d: Deps, who: LoginIdentity): Promise<Resolved> {
  const existing = await d.goTrue.find(who.email);
  // A login this provisioner did not create is somebody else's account: never adopted, never re-passworded, reset flag or not.
  if (existing && existing.purpose !== LOGIN_PURPOSE) {
    throw new Error(`the GoTrue login ${who.email} already exists and was not created by this provisioner (its user_metadata.purpose is not ours): refusing to adopt it, even with --reset-password. Remove it by hand if it is yours, or choose another address`);
  }
  const pick = choosePassword(who, existing !== null, d.env.readLogin(who), d.env.readPending(who), o.resetPassword);
  const verb = o.dryRun ? 'would be' : 'was';
  if (existing) {
    d.say(`GoTrue login ${who.email}: exists${pick.generated ? `; its password ${verb} reset and its sessions ended (--reset-password)` : pick.resumed ? '; its password is set again from the one an earlier run saved' : ''}`);
  } else {
    d.say(`GoTrue login ${who.email}: ${verb} created (email confirmed, no MFA)${pick.resumed ? ', with the password an earlier run saved' : ''}`);
  }
  if (o.dryRun) return { id: existing?.id ?? d.newId(), password: pick.password };
  if (pick.generated) d.env.writePending(who, pick.password); // before GoTrue holds it: nothing can be lost by dying next
  if (!existing) {
    const made = await d.goTrue.create(who, pick.password);
    if (made.purpose !== LOGIN_PURPOSE) throw new Error(`GoTrue answered the create of ${who.email} with an existing login that is not ours (it was made in the meantime); refusing to adopt it`);
    return { id: made.id, password: pick.password };
  }
  if (pick.generated || pick.resumed) await d.goTrue.setPassword(existing.id, pick.password); // a resumed one may never have reached GoTrue
  if (pick.generated) await d.goTrue.signOut(existing.id, who.email); // a reset hands the login a new password: every old session goes
  return { id: existing.id, password: pick.password };
}

/** Rolls back without ever hiding the error that brought it here: a failed ROLLBACK is logged and the connection is not trusted again. */
async function transact<T>(db: ClientBase, commit: boolean, body: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    const out = await body();
    await db.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await rollbackFailed(db, 'provision-verify-company');
    throw err;
  }
}

/** A cleanup that fails must not replace the run's own error (or its success): it is said and let go. */
async function quietly(say: (l: string) => void, what: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (err) { say(`warning: ${what} failed: ${err instanceof Error ? err.message : String(err)}`); }
}

export async function runProvisioning(o: RunOptions, d: Deps): Promise<RunResult> {
  // Real runs hold the deploy locks throughout; a dry run changes nothing, so it neither needs nor blocks them.
  const deployLocks = o.dryRun ? null : await d.deployLocks.acquire();
  try {
    if (!(await d.lock.acquire(d.db))) throw new Error('another provisioning run holds the lock on this database; wait for it to finish');
    try {
      return await provision(o, d);
    } finally {
      await quietly(d.say, 'releasing the run lock', () => d.lock.release(d.db));
    }
  } finally {
    if (deployLocks) await quietly(d.say, 'releasing the deploy locks', () => deployLocks.release());
  }
}

async function provision(o: RunOptions, d: Deps): Promise<RunResult> {
  const verify = await ensureLogin(o, d, VERIFY_LOGIN);
  const approver = await ensureLogin(o, d, APPROVER_LOGIN);
  const ids: UserIds = { verify: verify.id, approver: approver.id };

  const outcome = await transact(d.db, !o.dryRun, () => d.ensureDb(d.db, ids, d.now()));
  d.say(`database: verify user ${outcome.userCreated ? 'created' : 'exists'}, approver ${outcome.approverCreated ? 'created' : 'exists'}; `
    + `company ${outcome.companyId} ${outcome.companyCreated ? 'created' : 'exists'}; approver ${outcome.approverJoined ? 'added as' : 'already'} ${outcome.approverRole}; fiscal periods created ${outcome.periodsCreated}`);

  const ctx = { companyId: outcome.companyId, verifyUserId: ids.verify, now: d.now() };
  const plan = await d.plan(d.db, o.dryRun && outcome.companyCreated ? null : ctx);
  for (const p of plan) d.say(`seed through ${o.baseUrl}: ${p.name}: ${p.state === 'make' ? (o.dryRun ? 'would make' : 'make') : 'present, skipped'}`);
  if (o.dryRun) {
    d.say(`would write ${o.envFile}: ${[VERIFY_LOGIN, APPROVER_LOGIN].map((w) => `${w.emailKey}, ${w.passwordKey}`).join(', ')} (only those keys, mode kept or 0600)`);
    return { companyId: outcome.companyId, ran: [], wroteEnv: false };
  }

  const seeded = await d.seed(d.db, { companyId: outcome.companyId, verifyUserId: ids.verify, password: verify.password, now: d.now() });
  d.say(`seeded: ${seeded.ran.length ? seeded.ran.join(', ') : 'nothing (every block was already there)'}`);
  const problems = [...(await d.companyProblems(d.db, outcome.companyId, ids)), ...seeded.problems];
  if (problems.length) throw new Error(`the verify company is not usable: ${problems.join('; ')}`);

  const wroteEnv = d.env.writeLogins([
    { who: VERIFY_LOGIN, login: { email: VERIFY_LOGIN.email, password: verify.password } },
    { who: APPROVER_LOGIN, login: { email: APPROVER_LOGIN.email, password: approver.password } },
  ]);
  d.say(`${o.envFile}: ${[VERIFY_LOGIN, APPROVER_LOGIN].map((w) => `${w.emailKey}, ${w.passwordKey}`).join(', ')} ${wroteEnv ? 'written' : 'already current'}`);
  return { companyId: outcome.companyId, ran: seeded.ran, wroteEnv };
}
