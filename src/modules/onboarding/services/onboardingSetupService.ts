/**
 * Onboarding completion in ONE transaction: company + owner membership, entity
 * type, chart of accounts, people, documents and the user's onboarding flag.
 * The fiscal periods are rebuilt from the chosen financial year start.
 * Called by POST /api/onboarding/complete-setup after the request has passed
 * parseSetupRequest and the per-entity rules.
 *
 * Atomicity: every `sql` here runs on withAuth's request transaction, inside a
 * savepoint. A throw at any stage rolls the savepoint back, so no company,
 * membership, chart, person or document is left behind and a retry starts
 * clean. Belt and braces, any such failure also marks the request
 * rollbackOnly (als.ts), so withAuth cannot COMMIT it even if a caller turned
 * the error into a 4xx. The one exception is a clash on the request-key index
 * (OnboardingKeyConflictError): the savepoint has already undone everything,
 * and the route answers 409. Refuses to run outside a request transaction,
 * where each `sql` would commit on its own.
 *
 * Double submits: this user's request key (one per wizard session, re-sent on
 * retry) is locked for the transaction and looked up first, so a second
 * request with the key, concurrent or after a lost response, returns the
 * company the first one created instead of creating another (migration 895).
 */

import { als } from '@/lib/als';
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { seedChartOfAccountsFromTemplate } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import type { SetupRequest } from './onboardingSetupPayload';
import {
  createSetupCompany, findCompanyForRequestKey, insertSetupDocuments, insertSetupPeople,
  markOnboardingCompleted, scopeRequestToCompany,
} from './onboardingSetupWriters';

export interface SetupOutcome { companyId: string; replayed: boolean }

/** Another company already holds this user's request key (it was since deactivated, so it is not replayed). */
export class OnboardingKeyConflictError extends Error {
  constructor() { super('onboarding request key already used'); this.name = 'OnboardingKeyConflictError'; }
}

const isKeyClash = (err: unknown) => typeof err === 'object' && err !== null
  && (err as { code?: string }).code === '23505'
  && (err as { constraint?: string }).constraint === 'companies_onboarding_request_key_uniq';

export async function completeOnboardingSetup(req: SetupRequest, userId: string): Promise<SetupOutcome> {
  const store = als.getStore();
  if (!store?.client) {
    throw new Error('completeOnboardingSetup must run inside the request transaction (withAuth)');
  }
  const requestCompanyId = store.companyId;
  try {
    return await withSavepoint('onboarding_setup', () => runSetup(req, userId));
  } catch (err) {
    store.companyId = requestCompanyId; // the GUC went back with the savepoint
    if (isKeyClash(err)) throw new OnboardingKeyConflictError();
    store.rollbackOnly = 'onboarding complete-setup failed after it began writing';
    throw err;
  }
}

async function runSetup(req: SetupRequest, userId: string): Promise<SetupOutcome> {
  // Held until the request's COMMIT/ROLLBACK: a concurrent request with this
  // user's key waits here, then sees the committed company below.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`onboarding-setup:${userId}:${req.requestKey}`}, 0))`;

  const existing = await findCompanyForRequestKey(req.requestKey, userId);
  if (existing) {
    await markOnboardingCompleted(userId);
    log.info('Onboarding setup replayed', { companyId: existing, userId }, 'onboarding');
    return { companyId: existing, replayed: true };
  }

  const companyId = await createSetupCompany(req, userId);
  await scopeRequestToCompany(companyId);
  // The company has no periods (create_company_with_owner stopped pre-seeding
  // them, migration 942): generate its first year from the financial year start
  // the user chose. Later years follow on demand from this one.
  await generateFiscalYearForDate(companyId, new Date());
  await seedChartOfAccountsFromTemplate(companyId, req.coaTemplate); // 'blank' seeds nothing
  await insertSetupPeople(req, companyId);
  await insertSetupDocuments(companyId, req.documents, userId);
  await markOnboardingCompleted(userId);

  log.info('Onboarding setup completed', {
    companyId, userId, entityType: req.entityType, people: req.people.length, documents: req.documents.length,
  }, 'onboarding');
  return { companyId, replayed: false };
}
