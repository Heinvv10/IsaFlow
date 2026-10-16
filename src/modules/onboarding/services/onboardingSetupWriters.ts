/**
 * The writes of one onboarding completion, each a stage of
 * completeOnboardingSetup (onboardingSetupService.ts). They use the
 * request-scoped `sql`, so inside withAuth they all run on the request's one
 * transaction and commit or roll back together.
 */

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { createCompany } from '@/modules/accounting/services/core/companyService';
import { getEntityType } from '@/lib/entityTypes';
import { registrationNumberFor } from './entityOnboardingRules';
import type { SetupDocument, SetupRequest } from './onboardingSetupPayload';

/**
 * The stored key is md5(userId:requestKey) as a uuid, never the client's key
 * itself: two users sending the same key get different stored keys, so one
 * can neither collide with nor squat on another's.
 */
const storedKey = (userId: string, requestKey: string) => sql`md5(${userId} || ':' || ${requestKey})::UUID`;

/**
 * The live company this user's request key already created, if any (a retried
 * request). A company since deactivated, suspended or deleted is not replayed
 * (liveCompanies.ts's rule); its key still holds the unique index, so a new
 * create with that key ends in the route's 409.
 */
export async function findCompanyForRequestKey(requestKey: string, userId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT c.id FROM companies c
    JOIN company_users cu ON cu.company_id = c.id AND cu.user_id = ${userId}
    WHERE c.onboarding_request_key = ${storedKey(userId, requestKey)}
      AND c.is_active = true
      AND c.status IS DISTINCT FROM 'suspended'
      AND c.status IS DISTINCT FROM 'deleted'
      AND c.suspended_at IS NULL
  `) as { id: string }[];
  return rows[0]?.id ?? null;
}

/**
 * Creates the company and the caller's owner membership through
 * create_company_with_owner (SECURITY DEFINER: app_user may not INSERT either
 * row itself), then records the entity type and the request key on it.
 * The UPDATE passes RLS as the new owner (companies_admin_update), whose
 * membership row this transaction has just written.
 */
export async function createSetupCompany(req: SetupRequest, userId: string): Promise<string> {
  const c = req.company;
  const company = await createCompany({
    ...c,
    registrationNumber: registrationNumberFor(req.entityType, c.registrationNumber) ?? undefined,
    // Keep both VAT columns in step from the first write (AFS notes read vat_system_type).
    vatSystemType: c.vatSystemType ?? (c.vatPeriod === 'none' ? 'none' : 'invoice'),
  }, userId);
  const updated = (await sql`
    UPDATE companies
    SET entity_type = ${req.entityType}, onboarding_request_key = ${storedKey(userId, req.requestKey)}
    WHERE id = ${company.id}::UUID
    RETURNING id
  `) as { id: string }[];
  // RLS hides a row it will not let this user update: zero rows, no error.
  if (updated.length === 0) throw new Error('create-setup: the new company could not be updated (no row returned)');
  return company.id;
}

/**
 * Points the request's RLS scope at the new company for the rest of this
 * transaction. The WITH CHECK of gl_accounts, company_directors and
 * company_documents is `company_id = app.current_company_id()`, and withAuth
 * set that to the company the user was in (the active-company cookie), so
 * without this every later write for the new company is refused. Transaction
 * local, as withAuth's own set_config is.
 */
export async function scopeRequestToCompany(companyId: string): Promise<void> {
  await sql`SELECT set_config('app.current_company_id', ${companyId}, true)`;
  // Keep the request context in step with the GUC (nothing after this reads it
  // today; completeOnboardingSetup restores it if the setup fails).
  const store = als.getStore();
  if (store) store.companyId = companyId;
}

/** The people, each with the entity's role (Owner / Partner / Director / Member / Trustee / Representative). */
export async function insertSetupPeople(req: SetupRequest, companyId: string): Promise<void> {
  const role = getEntityType(req.entityType).personRole;
  for (const p of req.people) {
    await sql`
      INSERT INTO company_directors (company_id, name, id_number, role, id_document_name, id_document_data)
      VALUES (${companyId}::UUID, ${p.name}, ${p.idNumber}, ${role},
              ${p.idDocument?.name ?? null}, ${p.idDocument?.data ?? null})
    `;
  }
}

export async function insertSetupDocuments(companyId: string, documents: SetupDocument[], userId: string): Promise<void> {
  for (const d of documents) {
    await sql`
      INSERT INTO company_documents (company_id, document_type, document_name, file_data, mime_type, file_size, uploaded_by)
      VALUES (${companyId}::UUID, ${d.type}, ${d.name}, ${d.data}, ${d.mimeType}, ${d.size}, ${userId})
    `;
  }
}

export async function markOnboardingCompleted(userId: string): Promise<void> {
  await sql`UPDATE users SET onboarding_completed = true WHERE id = ${userId}`;
}
