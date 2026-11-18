// The pure half of the @isaflow.dev -> @isaflow.co.za move: the address builders, each account's plan, the env-file rewrite.
import { describe, expect, it } from 'vitest';
import {
  GOLDEN_SLOTS, LEGACY_EMAIL_DOMAIN, QA_EMAIL_DOMAIN, REPORTING_QA_APPROVER_EMAIL, REPORTING_QA_EMAIL, W6_EMAIL, slotEmail,
} from '../../../scripts/ci/golden/slotConfig';
import {
  formatPlan, knownAccounts, legacyEmail, planAccount, planEnvRewrite, type AccountState, type KnownAccount,
} from '../../../scripts/ci/golden/slotEmailPlan';
import { APPROVER_EMAIL, REQUESTER_EMAIL } from '../../e2e/rubric/_rubricGuard';

const slot1 = knownAccounts().find((a) => a.label === 'slot 1') as KnownAccount;
const w6 = knownAccounts().find((a) => a.label === 'wave-6 golden QA') as KnownAccount;
const state = (over: Partial<AccountState> = {}): AccountState => ({ gotrueOld: null, gotrueNew: null, usersOld: [], usersNew: [], companiesOld: 0, ...over });

describe('the address builders', () => {
  it('put every test login on isaflow.co.za, never on the domain with no DNS', () => {
    expect(QA_EMAIL_DOMAIN).toBe('isaflow.co.za');
    expect(slotEmail(2)).toBe('golden-slot-2@isaflow.co.za');
    expect(W6_EMAIL).toBe('golden-qa-w6@isaflow.co.za');
    for (const e of [slotEmail(1), slotEmail(3), W6_EMAIL, REPORTING_QA_EMAIL, REPORTING_QA_APPROVER_EMAIL]) expect(e.endsWith(`@${LEGACY_EMAIL_DOMAIN}`)).toBe(false);
  });

  it('keeps the rubric harness literals equal to the config', () => {
    expect(REQUESTER_EMAIL).toBe(REPORTING_QA_EMAIL);
    expect(APPROVER_EMAIL).toBe(REPORTING_QA_APPROVER_EMAIL);
  });

  it('legacyEmail swaps only the domain, case-insensitively', () => {
    expect(legacyEmail('golden-slot-1@isaflow.co.za')).toBe('golden-slot-1@isaflow.dev');
    expect(legacyEmail('Golden-Slot-1@ISAFLOW.CO.ZA')).toBe('Golden-Slot-1@isaflow.dev');
    expect(legacyEmail('x@isaflow.co.za.evil.com')).toBe('x@isaflow.co.za.evil.com');
  });

  it('knows exactly the slots, the w6 user and the two reporting-qa users', () => {
    expect(knownAccounts().map((a) => a.oldEmail)).toEqual([
      ...GOLDEN_SLOTS.map((n) => `golden-slot-${n}@isaflow.dev`),
      'golden-qa-w6@isaflow.dev', 'reporting-qa@isaflow.dev', 'reporting-qa-approver@isaflow.dev',
    ]);
    expect(knownAccounts().filter((a) => a.companyEmail).length).toBe(GOLDEN_SLOTS.length);
  });
});

describe('planAccount', () => {
  it('migrates an account still on the old address: database steps first, GoTrue last', () => {
    const p = planAccount(slot1, state({ gotrueOld: 'u1', usersOld: ['u1'], companiesOld: 2 }));
    expect(p.action).toBe('migrate');
    expect(p.userId).toBe('u1');
    expect(p.steps).toEqual(['users-email', 'companies-email', 'gotrue-email']);
  });

  it('is a no-op for an account already on the new address (idempotent)', () => {
    const p = planAccount(slot1, state({ gotrueNew: 'u1', usersNew: ['u1'], companiesOld: 0 }));
    expect(p.action).toBe('noop');
    expect(p.steps).toEqual([]);
  });

  it('finishes a half-done run: GoTrue already moved, users row not', () => {
    const p = planAccount(slot1, state({ gotrueNew: 'u1', usersOld: ['u1'], companiesOld: 1 }));
    expect(p.action).toBe('migrate');
    expect(p.steps).toEqual(['users-email', 'companies-email']);
  });

  it('does nothing for an account that does not exist anywhere', () => {
    const p = planAccount(w6, state());
    expect(p.action).toBe('noop');
    expect(p.notes[0]).toMatch(/nothing to migrate/);
  });

  it('only slots carry a company contact email', () => {
    expect(planAccount(w6, state({ gotrueOld: 'u1', usersOld: ['u1'], companiesOld: 5 })).steps).toEqual(['users-email', 'gotrue-email']);
  });

  it.each([
    ['the new address already belongs to another GoTrue user', state({ gotrueOld: 'u1', gotrueNew: 'u2' }), /already has/],
    ['the users row for the old address has another id', state({ gotrueOld: 'u1', usersOld: ['x'] }), /old.*another id|another id/],
    ['a users row already holds the new address under another id', state({ gotrueOld: 'u1', usersOld: ['u1'], usersNew: ['x'] }), /another id/],
    ['a users row exists with no GoTrue account', state({ usersOld: ['u1'] }), /no account/],
  ])('refuses when %s', (_l, s, re) => {
    const p = planAccount(slot1, s);
    expect(p.action).toBe('conflict');
    expect(p.steps).toEqual([]);
    expect(p.problems.join(' ')).toMatch(re);
  });

  it('formatPlan prints addresses and step names, nothing else', () => {
    expect(formatPlan(planAccount(slot1, state({ gotrueOld: 'u1', usersOld: ['u1'] })))).toBe(
      'slot 1: golden-slot-1@isaflow.dev -> golden-slot-1@isaflow.co.za: users-email, gotrue-email [user u1]');
    expect(formatPlan(planAccount(slot1, state({ gotrueOld: 'u1', gotrueNew: 'u2' })))).toMatch(/REFUSED/);
  });
});

describe('planEnvRewrite', () => {
  const text = [
    'DATABASE_URL=postgres://u@h:1/isaflow_dev',
    'GOLDEN_SLOT_1_EMAIL=golden-slot-1@isaflow.dev',
    'GOLDEN_SLOT_2_EMAIL=Golden-Slot-2@isaflow.dev',
    'GOLDEN_SLOT_3_EMAIL=golden-slot-3@isaflow.co.za',
    'GOLDEN_SLOT_1_NOTE=xyz-@isaflow.dev-inside',
    'SMTP_FROM=IsaFlow <noreply@isaflow.dev>',
    'OTHER_EMAIL=someone@isaflow.dev',
    'LOGIN_HINT=use golden-slot-1@isaflow.dev to sign in',
    '',
  ].join('\n');

  it('rewrites a line only when its whole value is a known old address, and reports key names only', () => {
    const r = planEnvRewrite(text, knownAccounts());
    expect(r.changedKeys).toEqual(['GOLDEN_SLOT_1_EMAIL', 'GOLDEN_SLOT_2_EMAIL']);
    expect(r.unrecognisedKeys).toEqual(['GOLDEN_SLOT_1_NOTE', 'SMTP_FROM', 'OTHER_EMAIL', 'LOGIN_HINT']);
    expect(r.text.split('\n')).toEqual([
      'DATABASE_URL=postgres://u@h:1/isaflow_dev',
      'GOLDEN_SLOT_1_EMAIL=golden-slot-1@isaflow.co.za',
      'GOLDEN_SLOT_2_EMAIL=golden-slot-2@isaflow.co.za',
      'GOLDEN_SLOT_3_EMAIL=golden-slot-3@isaflow.co.za',
      'GOLDEN_SLOT_1_NOTE=xyz-@isaflow.dev-inside',
      'SMTP_FROM=IsaFlow <noreply@isaflow.dev>',
      'OTHER_EMAIL=someone@isaflow.dev',
      'LOGIN_HINT=use golden-slot-1@isaflow.dev to sign in',
      '',
    ]);
  });

  it('is idempotent: a second pass changes nothing', () => {
    const once = planEnvRewrite(text, knownAccounts());
    const twice = planEnvRewrite(once.text, knownAccounts());
    expect(twice.changedKeys).toEqual([]);
    expect(twice.text).toBe(once.text);
  });
});
