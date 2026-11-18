/**
 * The pure half of migrate-slot-emails.ts: which test/QA accounts moved from @isaflow.dev (a domain with no DNS records,
 * so whoever registered it could receive their password-reset mail) to @isaflow.co.za, what each one's state is, and
 * which env-file lines carry the old address. No network, no database, no filesystem: tests/unit/ci/goldenSlotEmailPlan.test.ts.
 */
import {
  GOLDEN_SLOTS, LEGACY_EMAIL_DOMAIN, QA_EMAIL_DOMAIN, REPORTING_QA_APPROVER_EMAIL, REPORTING_QA_EMAIL, W6_EMAIL, slotEmail,
} from './slotConfig';

/** The same local part on the retired domain. */
export const legacyEmail = (email: string): string => email.replace(new RegExp(`@${QA_EMAIL_DOMAIN.replace(/\./g, '\\.')}$`, 'i'), `@${LEGACY_EMAIL_DOMAIN}`);

export interface KnownAccount {
  label: string;
  oldEmail: string;
  newEmail: string;
  /** A slot company carries the golden user's address as its own contact email (ensureCompany). */
  companyEmail: boolean;
}

/** Every @isaflow.dev account any code in the repo knows. Anything else on that domain is reported and never touched. */
export function knownAccounts(): KnownAccount[] {
  const mk = (label: string, newEmail: string, companyEmail = false): KnownAccount => ({ label, oldEmail: legacyEmail(newEmail), newEmail, companyEmail });
  return [
    ...GOLDEN_SLOTS.map((n) => mk(`slot ${n}`, slotEmail(n), true)),
    mk('wave-6 golden QA', W6_EMAIL),
    mk('reporting-qa', REPORTING_QA_EMAIL),
    mk('reporting-qa-approver', REPORTING_QA_APPROVER_EMAIL),
  ];
}

/** What was read, for one account. Ids are the GoTrue user id and `users.id` as text. */
export interface AccountState {
  gotrueOld: string | null;
  gotrueNew: string | null;
  usersOld: string[];
  usersNew: string[];
  /** Slot companies whose contact email is still the old address. */
  companiesOld: number;
}

export type Step = 'users-email' | 'companies-email' | 'gotrue-email';
export type Action = 'migrate' | 'noop' | 'conflict';

export interface AccountPlan {
  account: KnownAccount;
  action: Action;
  userId: string | null;
  /** In execution order: the database steps first, GoTrue last, so a GoTrue failure rolls the database back. */
  steps: Step[];
  /** Why the account is refused (action 'conflict'), or notes about an account that is simply not there. */
  problems: string[];
  notes: string[];
}

/**
 * One account's plan. The invariants: GoTrue's user id and `users.id` are the same person; the new address is free (or already
 * this user's); nothing is created. An already-migrated account has no steps (action 'noop'), so a re-run changes nothing.
 */
export function planAccount(account: KnownAccount, s: AccountState): AccountPlan {
  const problems: string[] = [];
  const notes: string[] = [];
  const userId = s.gotrueOld ?? s.gotrueNew;
  if (s.gotrueOld && s.gotrueNew) problems.push(`GoTrue already has ${account.newEmail} under another id than ${account.oldEmail}`);
  if (!userId) {
    if (s.usersOld.length || s.usersNew.length) problems.push('a users row exists but GoTrue has no account for it');
    else notes.push('no GoTrue account on either address (nothing to migrate)');
  } else {
    if (s.usersOld.some((id) => id !== userId)) problems.push(`the users row for ${account.oldEmail} has another id than GoTrue's`);
    if (s.usersNew.some((id) => id !== userId)) problems.push(`the users row for ${account.newEmail} has another id than GoTrue's`);
  }
  if (problems.length) return { account, action: 'conflict', userId, steps: [], problems, notes };
  const steps: Step[] = [];
  if (userId && s.usersOld.includes(userId)) steps.push('users-email');
  if (account.companyEmail && s.companiesOld > 0) steps.push('companies-email');
  if (s.gotrueOld) steps.push('gotrue-email');
  return { account, action: steps.length ? 'migrate' : 'noop', userId, steps, problems, notes };
}

export interface EnvRewrite {
  text: string;
  /** Keys whose value was exactly a known old address (names only: values are never reported). */
  changedKeys: string[];
  /** Keys whose value mentions the retired domain but is not a known account's address: left untouched. */
  unrecognisedKeys: string[];
}

/**
 * Rewrites every KEY=value line whose whole value is a known old address (case-insensitive) to the new one, keeping every
 * other byte of the file.
 */
export function planEnvRewrite(text: string, accounts: KnownAccount[]): EnvRewrite {
  const byOld = new Map(accounts.map((a) => [a.oldEmail.toLowerCase(), a.newEmail]));
  const changedKeys: string[] = [];
  const unrecognisedKeys: string[] = [];
  const legacy = new RegExp(`@${LEGACY_EMAIL_DOMAIN.replace(/\./g, '\\.')}`, 'i');
  const lines = text.split('\n').map((line) => {
    const m = /^(\s*([A-Za-z_][A-Za-z0-9_]*)=)(.*)$/.exec(line);
    if (!m) return line;
    const next = byOld.get(m[3]!.trim().toLowerCase());
    if (next) { changedKeys.push(m[2]!); return `${m[1]}${next}`; }
    if (legacy.test(m[3]!)) unrecognisedKeys.push(m[2]!);
    return line;
  });
  return { text: lines.join('\n'), changedKeys, unrecognisedKeys };
}

/** The dry-run / run report for one plan: addresses and step names only. */
export function formatPlan(p: AccountPlan): string {
  const head = `${p.account.label}: ${p.account.oldEmail} -> ${p.account.newEmail}`;
  if (p.action === 'conflict') return `${head}: REFUSED (${p.problems.join('; ')})`;
  if (p.action === 'noop') return `${head}: nothing to do${p.notes.length ? ` (${p.notes.join('; ')})` : ''}${p.userId ? ` [user ${p.userId}]` : ''}`;
  return `${head}: ${p.steps.join(', ')} [user ${p.userId}]`;
}
