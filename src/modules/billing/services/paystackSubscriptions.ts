/**
 * Paystack plans and subscriptions — server-driven recurring billing.
 * Re-exported from ./paystackClient.
 */

import { paystackFetch } from './paystackHttp';

// ---------------------------------------------------------------------------
// Plans + subscriptions — server-driven recurring billing
// ---------------------------------------------------------------------------

export interface CreatePlanInput {
  name: string;
  amountCents: number;
  interval: 'monthly' | 'annually' | 'weekly' | 'daily' | 'biannually' | 'quarterly';
  currency?: 'ZAR';
  description?: string;
}

export interface PlanResult {
  id: number;
  planCode: string;
  name: string;
  amountCents: number;
  interval: string;
}

interface PlanRaw {
  id: number;
  plan_code: string;
  name: string;
  amount: number;
  interval: string;
}

export async function createPlan(input: CreatePlanInput): Promise<PlanResult> {
  const data = await paystackFetch<PlanRaw>('/plan', {
    method: 'POST',
    body: {
      name: input.name,
      amount: input.amountCents,
      interval: input.interval,
      currency: input.currency ?? 'ZAR',
      description: input.description,
    },
  });
  return {
    id: data.id,
    planCode: data.plan_code,
    name: data.name,
    amountCents: data.amount,
    interval: data.interval,
  };
}

export interface CreateSubscriptionInput {
  /** Either a customer email or a CUS_ code. */
  customer: string;
  /** PLN_ code from createPlan. */
  planCode: string;
  /** Optional: pin to a specific authorization (else most recent). */
  authorizationCode?: string;
  /** ISO 8601 date for the first debit. */
  startDate?: string;
}

export interface SubscriptionResult {
  id: number;
  subscriptionCode: string;
  emailToken: string;
  status: string;
  amountCents: number;
}

interface SubscriptionRaw {
  id: number;
  subscription_code: string;
  email_token: string;
  status: string;
  amount: number;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<SubscriptionResult> {
  const data = await paystackFetch<SubscriptionRaw>('/subscription', {
    method: 'POST',
    body: {
      customer: input.customer,
      plan: input.planCode,
      authorization: input.authorizationCode,
      start_date: input.startDate,
    },
  });
  return {
    id: data.id,
    subscriptionCode: data.subscription_code,
    emailToken: data.email_token,
    status: data.status,
    amountCents: data.amount,
  };
}

export interface DisableSubscriptionInput {
  subscriptionCode: string;
  emailToken: string;
}

export async function disableSubscription(
  input: DisableSubscriptionInput,
): Promise<void> {
  await paystackFetch<unknown>('/subscription/disable', {
    method: 'POST',
    body: {
      code: input.subscriptionCode,
      token: input.emailToken,
    },
  });
}
