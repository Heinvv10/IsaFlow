/**
 * Changing a company's entity type after onboarding (PUT /api/accounting/companies,
 * Company Settings) must not leave it without the new type's required proof:
 * a company that becomes a CC needs its CK1/CK2 on file, a partnership two
 * partners with ID documents. Judged by the same proofIssues as onboarding,
 * from what is stored: active company_documents and company_directors (a
 * person counts as identified when id_document_name is set).
 */

import { sql } from '@/lib/neon';
import type { EntityTypeCode } from '@/lib/entityTypes';
import { proofIssues } from './entityOnboardingRules';

/** Why `companyId` cannot become `newType`; empty when it can, or when the type does not change. */
export async function entityTypeChangeIssues(companyId: string, newType: EntityTypeCode): Promise<string[]> {
  const company = (await sql`SELECT entity_type FROM companies WHERE id = ${companyId}::UUID`) as { entity_type: string | null }[];
  if (!company[0] || company[0].entity_type === newType) return [];
  const docs = (await sql`
    SELECT DISTINCT document_type FROM company_documents
    WHERE company_id = ${companyId}::UUID AND is_active IS NOT FALSE
  `) as { document_type: string }[];
  const people = (await sql`
    SELECT name, id_document_name FROM company_directors WHERE company_id = ${companyId}::UUID
  `) as { name: string; id_document_name: string | null }[];
  return proofIssues({
    entityType: newType,
    name: '',
    people: people.map(p => ({ name: p.name, hasIdDocument: p.id_document_name !== null })),
    documentTypes: docs.map(d => d.document_type),
  });
}
