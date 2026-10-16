/**
 * Changing a company's entity type after onboarding must not leave it without
 * the new type's required proof: a company that becomes a CC needs its CK1/CK2
 * on file, a partnership two different partners with ID documents, a sole
 * proprietor one owner. Judged by the same rules as onboarding over what is
 * stored:
 *  - proofIssues and tooManyPeopleIssues for the new type; duplicatePeopleIssues
 *    only when the new type's proof IS people's IDs (a legacy duplicate
 *    director does not block pty_ltd -> cc);
 *  - active company_documents (is_active = true, as statutoryDocService reads
 *    them) whose file is at least MIN_UPLOAD_BYTES;
 *  - company_directors, a person counting as identified only when
 *    id_document_data holds at least MIN_UPLOAD_BYTES (a name alone is not an ID).
 * Sizes are estimated from the stored base64 with whitespace and '=' padding
 * removed (as uploadLimits.decodedBytes); ID fingerprints are md5 of that
 * base64 with the url-safe alphabet mapped back, so equivalent encodings of one
 * file match. The company row is locked FOR UPDATE first, so two concurrent
 * changes serialise.
 *
 * Every writer of companies.entity_type calls assertEntityTypeChangeAllowed:
 * companyService.updateCompany (PUT /api/accounting/companies) and
 * PUT /api/accounting/afs/pis-score. The rows are read under the request's
 * RLS, whose USING clause is membership (not the active company), so a change
 * to another company the user belongs to sees that company's rows too
 * (tests/integration/onboarding-complete-setup-guards.int.test.ts).
 */

import { sql } from '@/lib/neon';
import { getEntityType, type EntityTypeCode } from '@/lib/entityTypes';
import { MIN_UPLOAD_BYTES } from '../uploadLimits';
import { duplicatePeopleIssues, proofIssues, tooManyPeopleIssues } from './entityOnboardingRules';

/** The company may not take the new type yet; `issues` say what is missing. */
export class EntityTypeChangeRefused extends Error {
  constructor(readonly issues: string[]) {
    super(`The company cannot become this entity type yet: ${issues.join('. ')}`);
    this.name = 'EntityTypeChangeRefused';
  }
}

/**
 * The base64 body of a stored data URL in a canonical form: no prefix, the
 * url-safe '-' and '_' mapped to '+' and '/', and whitespace and '=' padding
 * removed (translate deletes the from-characters past the to-string's length).
 */
// Built per call, not at import: tests mock '@/lib/neon' with partial factories.
const strip = () => sql`'-_ ' || chr(9) || chr(10) || chr(13) || '='`;
const fileBody = () => sql`translate(regexp_replace(file_data, '^data:[^,]*,', ''), ${strip()}, '+/')`;
const idBody = () => sql`translate(regexp_replace(id_document_data, '^data:[^,]*,', ''), ${strip()}, '+/')`;

/** Why `companyId` cannot become `newType`; empty when it can, or when the type does not change. */
export async function entityTypeChangeIssues(companyId: string, newType: EntityTypeCode): Promise<string[]> {
  const company = (await sql`
    SELECT entity_type FROM companies WHERE id = ${companyId}::UUID FOR UPDATE
  `) as { entity_type: string | null }[];
  // No row to lock (deleted, or not this user's to update under RLS): never "no issues".
  if (!company[0]) throw new Error(`entityTypeChangeIssues: no company row to lock for ${companyId}`);
  if (company[0].entity_type === newType) return [];
  const docs = (await sql`
    SELECT DISTINCT document_type FROM company_documents
    WHERE company_id = ${companyId}::UUID AND is_active = true
      AND length(${fileBody()}) * 3 / 4 >= ${MIN_UPLOAD_BYTES}
  `) as { document_type: string }[];
  const people = (await sql`
    SELECT name, id_number, identified, CASE WHEN identified THEN md5(body) END AS fingerprint
    FROM (
      SELECT name, id_number, ${idBody()} AS body,
             COALESCE(length(${idBody()}) * 3 / 4 >= ${MIN_UPLOAD_BYTES}, false) AS identified
      FROM company_directors WHERE company_id = ${companyId}::UUID
    ) d
  `) as { name: string; id_number: string | null; identified: boolean; fingerprint: string | null }[];
  const facts = people
    .filter(p => p.name.trim())
    .map(p => ({ name: p.name, hasIdDocument: p.identified, idNumber: p.id_number, idDocumentFingerprint: p.fingerprint }));
  const peopleProof = getEntityType(newType).requiredProof.kind === 'person_ids';
  return [
    ...tooManyPeopleIssues(newType, facts),
    ...(peopleProof ? duplicatePeopleIssues(facts) : []),
    ...proofIssues({ entityType: newType, name: '', people: facts, documentTypes: docs.map(d => d.document_type) }),
  ];
}

/** Throws EntityTypeChangeRefused when the stored proof does not support the new type. */
export async function assertEntityTypeChangeAllowed(companyId: string, newType: EntityTypeCode): Promise<void> {
  const issues = await entityTypeChangeIssues(companyId, newType);
  if (issues.length > 0) throw new EntityTypeChangeRefused(issues);
}
