/**
 * Onboarding completion in ONE transaction: company + owner membership, entity
 * type, chart of accounts, people, documents and the user's onboarding flag.
 * Called by POST /api/onboarding/complete-setup after the request has passed
 * parseSetupRequest and the per-entity rules.
 *
 * Atomicity comes from withAuth: every `sql` here runs on the request's
 * transaction, which withAuth commits only when the handler answers < 500. A
 * throw at any stage rolls every earlier stage back, so a failed completion
 * leaves no company, membership, chart, person or document behind, and a
 * retry starts clean. Refuses to run outside a request transaction, where
 * each `sql` would commit on its own.
 *
 * Double submits: the request key (one per wizard session, re-sent on retry)
 * is locked for the transaction and looked up first, so a second request with
 * the key, concurrent or after a lost response, returns the company the first
 * one created instead of creating another (migration 895).
 */

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { seedChartOfAccountsFromTemplate } from '@/modules/accounting/services/gl/chartOfAccountsService';
import type { SetupRequest } from './onboardingSetupPayload';
import {
  createSetupCompany, findCompanyForRequestKey, insertSetupDocuments, insertSetupPeople,
  markOnboardingCompleted, scopeRequestToCompany,
} from './onboardingSetupWriters';

export interface SetupOutcome { companyId: string; replayed: boolean }

export async function completeOnboardingSetup(req: SetupRequest, userId: string): Promise<SetupOutcome> {
  if (!als.getStore()?.client) {
    throw new Error('completeOnboardingSetup must run inside the request transaction (withAuth)');
  }
  // Held until the request's COMMIT/ROLLBACK: a concurrent request with this
  // key waits here, then sees the committed company below.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`onboarding-setup:${req.requestKey}`}, 0))`;

  const existing = await findCompanyForRequestKey(req.requestKey, userId);
  if (existing) {
    await markOnboardingCompleted(userId);
    log.info('Onboarding setup replayed', { companyId: existing, userId }, 'onboarding');
    return { companyId: existing, replayed: true };
  }

  const companyId = await createSetupCompany(req, userId);
  await scopeRequestToCompany(companyId);
  await seedChartOfAccountsFromTemplate(companyId, req.coaTemplate); // 'blank' seeds nothing
  await insertSetupPeople(req, companyId, req.people);
  await insertSetupDocuments(companyId, req.documents, userId);
  await markOnboardingCompleted(userId);

  log.info('Onboarding setup completed', {
    companyId, userId, entityType: req.entityType, people: req.people.length, documents: req.documents.length,
  }, 'onboarding');
  return { companyId, replayed: false };
}
