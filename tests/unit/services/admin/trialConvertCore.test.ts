/**
 * convertTrialInTx: the one conversion the admin "Convert to Paid" and the tenant's self-serve upgrade share.
 * The tx is faked and answers by statement text, so each test states only the rows that matter to it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { convertTrialInTx } from '@/modules/admin/services/trialConvertCore';
import { TrialConvertError } from '@/modules/admin/services/trialErrors';
import type { TxSql } from '@/lib/neon';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PLAN = '33333333-3333-4333-8333-333333333333';
const OTHER_PLAN = '44444444-4444-4444-8444-444444444444';

interface World {
  company: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
  paused: boolean;
  chargeableMandate: boolean;
  anyActiveMandate: boolean;
  /** Active Paystack mandates' max_amount_cents (the self-serve start sets it to the authorised plan's price). */
  ceilings: number[];
}
let world: World;
const seen: Array<{ text: string; values: unknown[] }> = [];

const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join('?').replace(/\s+/g, ' ').trim();
  seen.push({ text, values });
  if (/FROM companies/.test(text) && /FOR UPDATE/.test(text)) return world.company ? [world.company] : [];
  if (/FROM plans WHERE id/.test(text)) return world.plan ? [world.plan] : [];
  if (/FROM subscriptions s JOIN plans p/.test(text)) return world.current ? [world.current] : [];
  if (/status = 'paused' LIMIT 1/.test(text)) return world.paused ? [{ '?column?': 1 }] : [];
  if (/AS chargeable FROM subscription_mandates/.test(text)) {
    return world.anyActiveMandate
      ? world.ceilings.map((c, i) => ({ max_amount_cents: String(c), chargeable: i === 0 && world.chargeableMandate }))
      : [];
  }
  if (/paystack_authorization_code IS NOT NULL/.test(text)) return world.chargeableMandate ? [{ '?column?': 1 }] : [];
  if (/FROM subscription_mandates/.test(text)) return world.anyActiveMandate ? [{ '?column?': 1 }] : [];
  if (/^UPDATE subscriptions SET plan_id/.test(text) || /^INSERT INTO subscriptions/.test(text)) {
    return [{ id: 'sub-1', current_period_end: new Date('2026-12-24T00:00:00Z') }];
  }
  return [];
}) as unknown as TxSql;

const writes = () => seen.filter((s) => /^(UPDATE|INSERT)/.test(s.text));

beforeEach(() => {
  seen.length = 0;
  world = {
    company: { status: 'trial', had_trial: true },
    plan: { code: 'starter', is_active: true, monthly_price_cents: 59900 },
    current: { id: 'sub-1', status: 'trial', plan_id: 'trial-plan', current_period_end: new Date('2026-12-01T00:00:00Z'), is_paid: false },
    paused: false,
    chargeableMandate: true,
    anyActiveMandate: true,
    ceilings: [59900],
  };
});

describe('convertTrialInTx', () => {
  it('default options: converts as the admin path always has (no mandate needed)', async () => {
    world.chargeableMandate = false;
    world.anyActiveMandate = false;
    const r = await convertTrialInTx(tx, COMPANY, PLAN);
    expect(r).toEqual({ subscriptionId: 'sub-1', firstChargeAt: '2026-12-24T00:00:00.000Z', hasActiveMandate: false, alreadyConverted: false });
    expect(writes().map((w) => w.text.slice(0, 30))).toEqual([
      'UPDATE companies SET status = ',
      'UPDATE subscriptions SET plan_',
      'UPDATE subscriptions SET statu',
    ]);
    // Every statement is scoped to the company asked for.
    for (const s of seen.filter((x) => /company_id|companies/.test(x.text))) expect(s.values).toContain(COMPANY);
  });

  it('requireActiveMandate: refuses before any write when no chargeable mandate is on file', async () => {
    world.chargeableMandate = false;
    await expect(convertTrialInTx(tx, COMPANY, PLAN, { requireActiveMandate: true }))
      .rejects.toMatchObject({ name: 'TrialConvertError', code: 'mandate_required' });
    expect(writes()).toHaveLength(0);
  });

  it('requireActiveMandate: converts once a chargeable mandate is on file', async () => {
    const r = await convertTrialInTx(tx, COMPANY, PLAN, { requireActiveMandate: true });
    expect(r.hasActiveMandate).toBe(true);
    expect(writes().length).toBeGreaterThan(0);
  });

  it('requireActiveMandate: authorise cheap, convert dear is refused before any write', async () => {
    world.ceilings = [19900];
    await expect(convertTrialInTx(tx, COMPANY, PLAN, { requireActiveMandate: true }))
      .rejects.toMatchObject({ name: 'TrialConvertError', code: 'mandate_plan_mismatch' });
    expect(writes()).toHaveLength(0);
  });

  it('requireActiveMandate: any plan change needs a new authorisation (a cheaper plan is refused too)', async () => {
    world.ceilings = [99900];
    await expect(convertTrialInTx(tx, COMPANY, PLAN, { requireActiveMandate: true }))
      .rejects.toMatchObject({ code: 'mandate_plan_mismatch' });
    expect(writes()).toHaveLength(0);
  });

  it('requireActiveMandate: a second active mandate with another ceiling is refused', async () => {
    world.ceilings = [59900, 99900];
    await expect(convertTrialInTx(tx, COMPANY, PLAN, { requireActiveMandate: true }))
      .rejects.toMatchObject({ code: 'mandate_plan_mismatch' });
    expect(writes()).toHaveLength(0);
  });

  it('admin path (no requireActiveMandate) does not read the ceiling', async () => {
    world.ceilings = [100];
    await convertTrialInTx(tx, COMPANY, PLAN);
    expect(writes().length).toBeGreaterThan(0);
  });

  it('requireTrial: refuses a company that never had a trial', async () => {
    world.company = { status: 'active', had_trial: false };
    await expect(convertTrialInTx(tx, COMPANY, PLAN, { requireTrial: true }))
      .rejects.toMatchObject({ code: 'not_on_trial' });
    expect(writes()).toHaveLength(0);
  });

  it('samePlanIsNoop: a company already paying on the same plan is a no-op, nothing written', async () => {
    world.current = { id: 'sub-9', status: 'active', plan_id: PLAN, current_period_end: '2026-12-20T00:00:00.000Z', is_paid: true };
    const r = await convertTrialInTx(tx, COMPANY, PLAN, { samePlanIsNoop: true, requireActiveMandate: true });
    expect(r).toEqual({ subscriptionId: 'sub-9', firstChargeAt: '2026-12-20T00:00:00.000Z', hasActiveMandate: true, alreadyConverted: true });
    expect(writes()).toHaveLength(0);
  });

  it('samePlanIsNoop: paying on a DIFFERENT plan is still already_paid', async () => {
    world.current = { id: 'sub-9', status: 'active', plan_id: OTHER_PLAN, current_period_end: new Date(), is_paid: true };
    await expect(convertTrialInTx(tx, COMPANY, PLAN, { samePlanIsNoop: true }))
      .rejects.toMatchObject({ code: 'already_paid' });
    expect(writes()).toHaveLength(0);
  });

  it('without samePlanIsNoop, paying on the same plan is already_paid (admin behaviour unchanged)', async () => {
    world.current = { id: 'sub-9', status: 'active', plan_id: PLAN, current_period_end: new Date(), is_paid: true };
    await expect(convertTrialInTx(tx, COMPANY, PLAN)).rejects.toBeInstanceOf(TrialConvertError);
  });

  it('refuses a missing company, a suspended one, an internal plan and a paused subscription before any write', async () => {
    const cases: Array<[Partial<World>, string]> = [
      [{ company: null }, 'company_not_found'],
      [{ company: { status: 'suspended', had_trial: true } }, 'company_not_convertible'],
      [{ plan: null }, 'plan_not_found'],
      [{ plan: { code: 'payg', is_active: true } }, 'plan_not_convertible'],
      [{ plan: { code: 'starter', is_active: false } }, 'plan_not_convertible'],
      [{ paused: true }, 'subscription_paused'],
    ];
    for (const [patch, code] of cases) {
      seen.length = 0;
      const saved = { ...world };
      Object.assign(world, patch);
      await expect(convertTrialInTx(tx, COMPANY, PLAN, { requireActiveMandate: true }), code).rejects.toMatchObject({ code });
      expect(writes(), code).toHaveLength(0);
      world = saved;
    }
  });

  it('inserts a subscription when the company has no live one', async () => {
    world.current = null;
    await convertTrialInTx(tx, COMPANY, PLAN);
    expect(writes().map((w) => w.text.slice(0, 26))).toEqual(['UPDATE companies SET statu', 'INSERT INTO subscriptions ']);
  });
});
