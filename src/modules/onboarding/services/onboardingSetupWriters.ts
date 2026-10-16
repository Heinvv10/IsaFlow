/**
 * The writes of one onboarding completion, each a stage of
 * completeOnboardingSetup (onboardingSetupService.ts). They use the
 * request-scoped `sql`, so inside withAuth they all run on the request's one
 * transaction and commit or roll back together.
 */

import { sql } from '@/lib/neon';
import { createCompany } from '@/modules/accounting/services/core/companyService';
import { getEntityType } from '@/lib/entityTypes';
import { registrationNumberFor } from './entityOnboardingRules';
import type { SetupDocument, SetupPerson, SetupRequest } from './onboardingSetupPayload';

/** The company this request key already created for this user, if any (a retried request). */
export async function findCompanyForRequestKey(requestKey: string, userId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT c.id FROM companies c
    JOIN company_users cu ON cu.company_id = c.id AND cu.user_id = ${userId}
    WHERE c.onboarding_request_key = ${requestKey}::UUID
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
  await sql`
    UPDATE companies
    SET entity_type = ${req.entityType}, onboarding_request_key = ${req.requestKey}::UUID
    WHERE id = ${company.id}::UUID
  `;
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
}

/** The people, each with the entity's role (Owner / Partner / Director / Member / Trustee / Representative). */
export async function insertSetupPeople(req: SetupRequest, companyId: string, people: SetupPerson[]): Promise<void> {
  const role = getEntityType(req.entityType).personRole;
  for (const p of people) {
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
