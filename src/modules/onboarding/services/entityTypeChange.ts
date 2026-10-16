/**
 * Changing a company's entity type after onboarding must not leave it without
 * the new type's required proof: a company that becomes a CC needs its CK1/CK2
 * on file, a partnership two different partners with ID documents. Judged by
 * the same rules as onboarding (proofIssues + the duplicate-people rule) over
 * what is stored:
 *  - active company_documents (is_active = true, as statutoryDocService reads
 *    them) whose file is at least MIN_UPLOAD_BYTES;
 *  - company_directors, a person counting as identified only when
 *    id_document_data holds at least MIN_UPLOAD_BYTES (a name alone is not an ID).
 * Sizes are the decoded size estimated from the stored base64 length.
 *
 * Every writer of companies.entity_type calls assertEntityTypeChangeAllowed:
 * companyService.updateCompany (PUT /api/accounting/companies) and
 * PUT /api/accounting/afs/pis-score. The rows are read under the request's
 * RLS, whose USING clause is membership (not the active company), so a change
 * to another company the user belongs to sees that company's rows too
 * (tests/integration/onboarding-complete-setup-guards.int.test.ts).
 */

import { sql } from '@/lib/neon';
import type { EntityTypeCode } from '@/lib/entityTypes';
import { MIN_UPLOAD_BYTES } from '../uploadLimits';
import { duplicatePeopleIssues, proofIssues } from './entityOnboardingRules';

/** The company may not take the new type yet; `issues` say what is missing. */
export class EntityTypeChangeRefused extends Error {
  constructor(readonly issues: string[]) {
    super(`The company cannot become this entity type yet: ${issues.join('. ')}`);
    this.name = 'EntityTypeChangeRefused';
  }
}

/** Why `companyId` cannot become `newType`; empty when it can, or when the type does not change. */
export async function entityTypeChangeIssues(companyId: string, newType: EntityTypeCode): Promise<string[]> {
  const company = (await sql`SELECT entity_type FROM companies WHERE id = ${companyId}::UUID`) as { entity_type: string | null }[];
  if (!company[0] || company[0].entity_type === newType) return [];
  const docs = (await sql`
    SELECT DISTINCT document_type FROM company_documents
    WHERE company_id = ${companyId}::UUID AND is_active = true
      AND length(regexp_replace(file_data, '^data:[^,]*,', '')) * 3 / 4 >= ${MIN_UPLOAD_BYTES}
  `) as { document_type: string }[];
  const people = (await sql`
    SELECT name, id_number,
      COALESCE(length(regexp_replace(id_document_data, '^data:[^,]*,', '')) * 3 / 4 >= ${MIN_UPLOAD_BYTES}, false) AS identified,
      md5(regexp_replace(regexp_replace(id_document_data, '^data:[^,]*,', ''), '[[:space:]]', '', 'g')) AS fingerprint
    FROM company_directors WHERE company_id = ${companyId}::UUID
  `) as { name: string; id_number: string | null; identified: boolean; fingerprint: string | null }[];
  const facts = people
    .filter(p => p.name.trim())
    .map(p => ({ name: p.name, hasIdDocument: p.identified, idNumber: p.id_number, idDocumentFingerprint: p.identified ? p.fingerprint : null }));
  return [
    ...duplicatePeopleIssues(facts),
    ...proofIssues({ entityType: newType, name: '', people: facts, documentTypes: docs.map(d => d.document_type) }),
  ];
}

/** Throws EntityTypeChangeRefused when the stored proof does not support the new type. */
export async function assertEntityTypeChangeAllowed(companyId: string, newType: EntityTypeCode): Promise<void> {
  const issues = await entityTypeChangeIssues(companyId, newType);
  if (issues.length > 0) throw new EntityTypeChangeRefused(issues);
}
