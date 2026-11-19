/**
 * The provisioning run, in order, with everything it touches passed in (so the order and the dry-run promise are tested,
 * not just read). scripts/deploy/provision-verify-company.ts wires the real GoTrue, database, app and env file.
 *
 *   0. the deploy locks (a real run only: refused while a deploy, rollback or restart runs), then the database run lock (one run at a time);
 *   1. GoTrue, per login: look it up; a new login's password is saved to the env file's PENDING key straight after the create
 *      (and before any password change of an existing one), so a run that dies later is re-run plainly, never with --reset-password;
 *   2. the database, one transaction (users, company, approver membership, fiscal years), rolled back by --dry-run;
 *   3. the running app seeds the blocks as the verify login;
 *   4. the readiness gate (the database's view, then the golden suite's own checks through the app as both logins); then, LAST, the
 *      logins' keys (and the pending keys' removal), so a deploy never reads a half-made company or one the suite would not start in.
 * --dry-run writes nothing anywhere: no GoTrue write, no commit, no seed, no env file.
 */
import type { ClientBase } from 'pg';
import type { Login } from './envFile';
import { APPROVER_LOGIN, LOGIN_PURPOSE, VERIFY_LOGIN, type LoginIdentity } from './identity';
import { choosePassword, type PasswordChoice } from './password';
import { rollbackFailed } from '../../../src/lib/rollbackFailed';
import { actorRank } from '../../../src/modules/accounting/services/gl/approvalRank';
import { sendsSecureCookies } from '../../../tests/e2e/golden-paths/helpers/suitePreconditions';
import type { DbOutcome, UserIds } from './provisionDb';
import type { PlanLine } from './seedVerifyCompany';

export interface RunOptions { dryRun: boolean; resetPassword: boolean; baseUrl: string; envFile: string }

export interface Deps {
  say(line: string): void;
  now(): Date;
  newId(): string;
  /** Whether a GoTrue sign-out can be done here (JWT_SECRET and SUPABASE_ANON_KEY present): checked before any change that needs one. */
  canSignOut(): boolean;
  db: ClientBase;
  lock: { acquire(db: ClientBase): Promise<boolean>; unlock(db: ClientBase): Promise<void> };
  /** The deploy locks (deployLock.ts), taken for a real run only: rejects when a deploy holds one. */
  deployLocks: { acquire(): Promise<{ unlock(): Promise<void> }> };
  goTrue: {
    /** `purpose`: the login's app_metadata.purpose (admin-only), which marks one this provisioner created; `legacyPurpose`: the user_metadata one an earlier version stamped. */
    find(email: string): Promise<{ id: string; purpose: string | null; legacyPurpose: string | null } | null>;
    create(who: LoginIdentity, password: string): Promise<{ id: string; purpose: string | null }>;
    /** Stamps a login we own with the admin-only marker (migrating an earlier version's user_metadata one). */
    stamp(id: string): Promise<void>;
    setPassword(id: string, password: string): Promise<void>;
    /** Revokes every refresh token of the login (GoTrue's global logout). */
    signOut(id: string, email: string): Promise<void>;
  };
  env: {
    readLogin(who: LoginIdentity): Login | null;
    readPending(who: LoginIdentity): string | null;
    readId(who: LoginIdentity): string | null;
    recordId(who: LoginIdentity, id: string): void;
    writePending(who: LoginIdentity, password: string): void;
    writeLogins(logins: Array<{ who: LoginIdentity; login: Login; id?: string }>): boolean;
  };
  ensureDb(db: ClientBase, ids: UserIds, today: Date): Promise<DbOutcome>;
  plan(db: ClientBase, ctx: { companyId: string; verifyUserId: string; now: Date; financialYearStart: number } | null): Promise<PlanLine[]>;
  seed(db: ClientBase, o: { companyId: string; verifyUserId: string; password: string; now: Date; financialYearStart: number }): Promise<{ ran: string[]; problems: string[] }>;
  companyProblems(db: ClientBase, companyId: string, ids: UserIds): Promise<string[]>;
  /** The golden suite's own start-up checks, logged in through the app as both logins (suiteReadiness.ts): empty when the suite would start. */
  suiteProblems(passwords: { verify: string; approver: string }): Promise<string[]>;
}

export interface RunResult { companyId: string; ran: string[]; wroteEnv: boolean }

interface Resolved { id: string; password: string }

/** What a login needs, decided from reads alone (no write): so every refusal comes before the first change to GoTrue or the env file. */
interface Inspected {
  who: LoginIdentity;
  existing: { id: string; purpose: string | null; legacyPurpose: string | null } | null;
  legacyOurs: boolean;
  pick: PasswordChoice;
  /** The login exists, was published before and gets a new password: its old sessions must end. A login made in this or a crashed run has none worth revoking. */
  signOut: boolean;
}

async function inspect(o: RunOptions, d: Deps, who: LoginIdentity): Promise<Inspected> {
  const existing = await d.goTrue.find(who.email);
  // A login this provisioner did not create is somebody else's account: never adopted, never re-passworded, reset flag or not. Ours
  // carries the admin-only app_metadata marker; one an earlier version stamped in user_metadata (which its user could have written)
  // counts only when its GoTrue id is the one this deploy env file recorded.
  const legacyMarked = existing !== null && existing.purpose === null && existing.legacyPurpose === LOGIN_PURPOSE;
  const legacyOurs = legacyMarked && d.env.readId(who) === existing.id;
  if (existing && existing.purpose !== LOGIN_PURPOSE && !legacyOurs) {
    if (legacyMarked) {
      throw new Error(`the GoTrue login ${who.email} was made by an earlier version of this tool (its marker is in user_metadata, which its user could have written) and its id is not recorded in the env file, so it is not trusted as ours: delete it by hand in GoTrue (admin API) and run again, or record its id under ${who.idKey} if you know it is ours`);
    }
    throw new Error(`the GoTrue login ${who.email} already exists and was not created by this provisioner (its app_metadata.purpose is not ours): refusing to adopt it, even with --reset-password. Remove it by hand if it is yours, or choose another address`);
  }
  const fileLogin = d.env.readLogin(who);
  const pick = choosePassword(who, existing !== null, fileLogin, d.env.readPending(who), o.resetPassword);
  // Published before = the env file holds its final login. A reset has one; so does a reset that died after setPassword (pending still there).
  const signOut = existing !== null && (pick.generated || (pick.resumed && fileLogin !== null));
  return { who, existing, legacyOurs, pick, signOut };
}

async function apply(o: RunOptions, d: Deps, x: Inspected): Promise<Resolved> {
  const { who, existing, legacyOurs, pick } = x;
  const verb = o.dryRun ? 'would be' : 'was';
  if (existing) {
    d.say(`GoTrue login ${who.email}: exists${legacyOurs ? ' (marker migrated to app_metadata)' : ''}${pick.generated ? `; its password ${verb} reset and its sessions ended (--reset-password)` : pick.resumed ? `; its password is set again from the one an earlier run saved${x.signOut ? ' and its sessions ended' : ''}` : ''}`);
  } else {
    d.say(`GoTrue login ${who.email}: ${verb} created (email confirmed, no MFA)${pick.resumed ? ', with the password an earlier run saved' : ''}`);
  }
  if (o.dryRun) return { id: existing?.id ?? d.newId(), password: pick.password };
  if (pick.generated) d.env.writePending(who, pick.password); // before GoTrue holds it: nothing can be lost by dying next
  if (!existing) {
    const made = await d.goTrue.create(who, pick.password);
    if (made.purpose !== LOGIN_PURPOSE) throw new Error(`GoTrue answered the create of ${who.email} with an existing login that is not ours (it was made in the meantime); refusing to adopt it`);
    d.env.recordId(who, made.id);
    return { id: made.id, password: pick.password };
  }
  if (legacyOurs) await d.goTrue.stamp(existing.id);
  if (pick.generated || pick.resumed) await d.goTrue.setPassword(existing.id, pick.password); // a resumed one may never have reached GoTrue
  if (x.signOut) await d.goTrue.signOut(existing.id, who.email);
  return { id: existing.id, password: pick.password };
}

/** Rolls back without ever hiding the error that brought it here: a failed ROLLBACK is logged and the connection is not trusted again. */
async function transact<T>(db: ClientBase, commit: boolean, body: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  let out: T;
  try {
    out = await body();
    if (commit) await db.query('COMMIT');
  } catch (err) {
    await rollbackFailed(db, 'provision-verify-company');
    throw err;
  }
  // A dry run's ROLLBACK goes through the same bounded helper (R-176); one that fails leaves the outcome unknown, so the run fails.
  if (!commit && (await rollbackFailed(db, 'provision-verify-company'))) throw new Error('the dry run could not be rolled back');
  return out;
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
      await quietly(d.say, 'releasing the run lock', () => d.lock.unlock(d.db));
    }
  } finally {
    if (deployLocks) await quietly(d.say, 'releasing the deploy locks', () => deployLocks.unlock());
  }
}

async function provision(o: RunOptions, d: Deps): Promise<RunResult> {
  // Everything that can refuse is decided before anything is changed: a half-done password change is the outage this prevents.
  const inspected = [await inspect(o, d, VERIFY_LOGIN), await inspect(o, d, APPROVER_LOGIN)];
  const signingOut = inspected.filter((x) => x.signOut);
  if (signingOut.length && !d.canSignOut()) {
    throw new Error(`${signingOut.map((x) => x.who.email).join(' and ')} must be signed out after its password changes, which needs JWT_SECRET and SUPABASE_ANON_KEY in the environment, and they are missing: nothing was changed. `
      + 'The wrapper passes them for --reset-password and whenever the env file holds a pending password');
  }
  const verify = await apply(o, d, inspected[0]!);
  const approver = await apply(o, d, inspected[1]!);
  const ids: UserIds = { verify: verify.id, approver: approver.id };

  const outcome = await transact(d.db, !o.dryRun, () => d.ensureDb(d.db, ids, d.now()));
  d.say(`database: verify user ${outcome.userCreated ? 'created' : 'exists'}, approver ${outcome.approverCreated ? 'created' : 'exists'}; `
    + `company ${outcome.companyId} ${outcome.companyCreated ? 'created' : 'exists'}; approver ${outcome.approverJoined ? 'added as' : 'already'} ${outcome.approverActualRole}; fiscal periods created ${outcome.periodsCreated}`);
  if (actorRank(outcome.approverActualRole) > actorRank(outcome.approverRole)) {
    d.say(`warning: the approver's existing membership is ${outcome.approverActualRole}, above the least role that can decide a pay run (${outcome.approverRole}); it is left as it is: lower it by hand`);
  }

  const ctx = { companyId: outcome.companyId, verifyUserId: ids.verify, now: d.now(), financialYearStart: outcome.financialYearStart };
  const plan = await d.plan(d.db, o.dryRun && outcome.companyCreated ? null : ctx);
  for (const p of plan) d.say(`seed through ${o.baseUrl}: ${p.name}: ${p.state === 'make' ? (o.dryRun ? 'would make' : 'make') : 'present, skipped'}`);
  if (o.dryRun) {
    d.say(`would then log in through ${o.baseUrl} as both logins and run the golden suite's start-up checks (session, company, system accounts)`
      + (sendsSecureCookies(o.baseUrl) ? '' : `; warning: the suite's client sends a production build's Secure cookies over plain http only to localhost, so against a production app at ${o.baseUrl} that check fails: use http://localhost:<port>`));
    d.say(`would write ${o.envFile}: ${[VERIFY_LOGIN, APPROVER_LOGIN].map((w) => `${w.emailKey}, ${w.passwordKey}`).join(', ')} (only those keys, mode kept or 0600)`);
    return { companyId: outcome.companyId, ran: [], wroteEnv: false };
  }

  const seeded = await d.seed(d.db, { companyId: outcome.companyId, verifyUserId: ids.verify, password: verify.password, now: d.now(), financialYearStart: outcome.financialYearStart });
  d.say(`seeded: ${seeded.ran.length ? seeded.ran.join(', ') : 'nothing (every block was already there)'}`);
  const problems = [...(await d.companyProblems(d.db, outcome.companyId, ids)), ...seeded.problems,
    ...(await d.suiteProblems({ verify: verify.password, approver: approver.password }))];
  if (problems.length) throw new Error(`the verify company is not usable: ${problems.join('; ')}`);

  const wroteEnv = d.env.writeLogins([
    { who: VERIFY_LOGIN, login: { email: VERIFY_LOGIN.email, password: verify.password }, id: verify.id },
    { who: APPROVER_LOGIN, login: { email: APPROVER_LOGIN.email, password: approver.password }, id: approver.id },
  ]);
  d.say(`${o.envFile}: ${[VERIFY_LOGIN, APPROVER_LOGIN].map((w) => `${w.emailKey}, ${w.passwordKey}`).join(', ')} ${wroteEnv ? 'written' : 'already current'}`);
  return { companyId: outcome.companyId, ran: seeded.ran, wroteEnv };
}
