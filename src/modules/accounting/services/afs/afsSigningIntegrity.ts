// src/modules/accounting/services/afs/afsSigningIntegrity.ts
//
// What the signatories sign is the document as it stood when it was sent. The send records a
// fingerprint over every input the statements are rendered from, and a digest per input; the
// signature webhook signs the document off only while that fingerprint still holds and every
// mandatory section is still signed off. Anything else is a signature over content the database no longer holds, so it is
// refused, the reason recorded, and the document handed back for a fresh send.
import { log } from '@/lib/logger';
import type { BrandProfile } from './afsTypes';

/** A tagged-template query: the request-bound `sql`, or a `withTransaction` tx. */
export type Query = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

/** The four inputs the statements are rendered from, each hashed on its own. */
export interface SigningInputDigests {
  document: string;
  company: string;
  brand: string;
  sections: string;
}

const INPUT_LABELS: Record<keyof SigningInputDigests, string> = {
  document: 'the reporting period (year or period)',
  company: 'the registered company name or number',
  brand: 'the firm branding',
  sections: 'section content',
};

/**
 * sha256 over EXACTLY the values the statements are rendered from — no more, no less: the
 * period (or fiscal year) on the cover, the registered company name and number, the branding
 * the CSS and cover use (or the marker for the documented default when a company has saved
 * none), and each section's id, type (it picks the chart), note number, content, overrides and
 * chart data. Anything the render never prints — the footer text, the document type and
 * framework, review status, a draft AI narrative — is left out, so changing it cannot void a
 * signature over identical bytes. Sections are aggregated in the render's own order (note
 * number, then id). One digest per input lets a refusal say which moved. The pre-image is
 * jsonb text: NULL stays distinct from '' and every string is quoted, so no two different
 * inputs can produce the same bytes. This is the only copy of the expression.
 *
 * The logo is covered by its URL, not its image: Signum fetches the image itself, so the
 * picture behind an unchanged URL can differ between the send and a signature.
 */
export async function documentContentFingerprint(
  q: Query,
  companyId: string,
  documentId: string,
): Promise<{ fingerprint: string; digests: SigningInputDigests }> {
  const { fingerprint, digests } = await snapshotRenderInputs(q, companyId, documentId);
  return { fingerprint, digests };
}

/** What the send renders from: the values the fingerprint was taken over, in the same statement. */
export interface RenderInputSnapshot {
  fingerprint: string;
  digests: SigningInputDigests;
  companyName: string;
  registrationNumber: string | null;
  /** Null when the company has saved none: the render then uses DEFAULT_BRAND_PROFILE. */
  brandProfile: BrandProfile | null;
}

/**
 * Reads the company and brand inputs ONCE and fingerprints them in the SAME statement — one
 * statement is one snapshot even under READ COMMITTED — and returns the values so the send
 * renders from exactly what was fingerprinted, rather than letting the renderer re-read the
 * tables. No lock is taken on the company or its branding: a later edit to either simply makes
 * the webhook's recomputation differ, and the signature is refused, naming the input. (The
 * document and its sections are held by the send's document lock, which every section write
 * respects.)
 */
export async function snapshotRenderInputs(
  q: Query,
  companyId: string,
  documentId: string,
): Promise<RenderInputSnapshot> {
  const rows = (await q`
      SELECT x.id, x.company_id, x.digests, x.company_name, x.company_registration, x.brand_row,
             encode(sha256(convert_to(jsonb_build_object('v', 3, 'inputs', x.digests)::text, 'UTF8')), 'hex') AS fingerprint
      FROM (
        SELECT p.id, p.company_id, p.company_name, p.company_registration, p.brand_row,
               jsonb_build_object('document', encode(sha256(convert_to(p.document_part::text, 'UTF8')), 'hex'), 'company', encode(sha256(convert_to(p.company_part::text, 'UTF8')), 'hex'),
                 'brand', encode(sha256(convert_to(p.brand_part::text, 'UTF8')), 'hex'), 'sections', encode(sha256(convert_to(p.sections_part::text, 'UTF8')), 'hex')) AS digests
        FROM (
          SELECT d.id, d.company_id,
        c.name AS company_name, c.registration_number AS company_registration, to_jsonb(b) AS brand_row,
        jsonb_build_object('fiscal_year', d.fiscal_year, 'period', d.period) AS document_part,
        jsonb_build_object('name', c.name, 'registration_number', c.registration_number) AS company_part,
        CASE WHEN b.company_id IS NULL THEN jsonb_build_object('default_profile', true)
             ELSE jsonb_build_object('default_profile', false, 'logo_url', b.logo_url,
               'primary_colour', b.primary_colour, 'secondary_colour', b.secondary_colour,
               'font_family', b.font_family, 'cover_style', b.cover_style) END AS brand_part,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
                   'id', s.id, 'section_type', s.section_type, 'sort_order', s.sort_order,
                   'content', s.content, 'overrides', s.overrides,
                   'data_snapshot', s.data_snapshot) ORDER BY s.sort_order, s.id)
          FROM afs_sections s
          WHERE s.document_id = d.id AND s.company_id = d.company_id
        ), '[]'::jsonb) AS sections_part
          FROM afs_documents d
          JOIN companies c ON c.id = d.company_id
          LEFT JOIN brand_profiles b ON b.company_id = d.company_id
          WHERE d.id = ${documentId}::UUID AND d.company_id = ${companyId}::UUID
        ) p
      ) x
  `) as Record<string, unknown>[];
  const row = rows[0];
  if (!row) throw new Error(`Cannot fingerprint AFS document ${documentId}: not found`);
  const brand = row.brand_row as Record<string, unknown> | null;
  return {
    fingerprint: String(row.fingerprint),
    digests: row.digests as SigningInputDigests,
    companyName: String(row.company_name),
    registrationNumber: (row.company_registration as string | null) ?? null,
    brandProfile: brand === null ? null : {
      id: brand.id as string,
      companyId: brand.company_id as string,
      logoUrl: (brand.logo_url as string | null) ?? null,
      primaryColour: brand.primary_colour as string,
      secondaryColour: brand.secondary_colour as string,
      fontFamily: brand.font_family as BrandProfile['fontFamily'],
      coverStyle: brand.cover_style as BrandProfile['coverStyle'],
      reportFooterText: (brand.report_footer_text as string | null) ?? null,
      createdAt: brand.created_at as string,
      updatedAt: brand.updated_at as string,
    },
  };
}

/** Null when the document may be signed as it stands; otherwise why it may not. */
export async function signatureRefusalReason(
  q: Query,
  companyId: string,
  documentId: string,
  atSend: { fingerprint: string | null; digests: SigningInputDigests | null },
): Promise<string | null> {
  // Not a state the product produces (the send records the fingerprint in the same statement
  // that marks the document out for signature), but a hand-made row must not be signed over.
  if (!atSend.fingerprint) {
    return 'There is no record of what was sent for signature, so this signature cannot be matched to the statements — send it for signature again';
  }
  // Counted on the same connection as the fingerprint, so both see one state of the document.
  const counted = (await q`
    SELECT COUNT(*)::int AS cnt
    FROM afs_sections s
    JOIN afs_documents d ON d.id = s.document_id AND d.company_id = ${companyId}::UUID
    LEFT JOIN LATERAL (
      SELECT nt.is_mandatory
      FROM note_templates nt
      WHERE nt.section_type = s.section_type
        AND nt.framework IN (d.reporting_framework, 'both')
      ORDER BY (nt.framework = d.reporting_framework) DESC
      LIMIT 1
    ) nt ON TRUE
    WHERE s.document_id = ${documentId}::UUID
      AND s.company_id = ${companyId}::UUID
      AND COALESCE(nt.is_mandatory, TRUE)
      AND s.status <> 'signed_off'
  `) as Record<string, unknown>[];
  const notSignedOff = Number(counted[0]?.cnt ?? 0);
  if (notSignedOff > 0) return `${notSignedOff} mandatory section(s) are not signed off`;

  const now = await documentContentFingerprint(q, companyId, documentId);
  if (now.fingerprint === atSend.fingerprint) return null;
  // Name the input(s) that moved, so the operator looks where the change is. A document whose
  // digests are missing (only possible for a hand-made row) gets the general statement.
  const changed = atSend.digests
    ? (Object.keys(INPUT_LABELS) as Array<keyof SigningInputDigests>)
        .filter(key => atSend.digests?.[key] !== now.digests[key])
        .map(key => INPUT_LABELS[key])
    : [];
  return changed.length > 0
    ? `Changed after the document was sent for signature: ${changed.join('; ')}`
    : 'The statements changed after the document was sent for signature';
}

/** Documents of this company whose signature an edit to its settings or branding will void. */
export async function signingInvalidationWarnings(q: Query, companyId: string, what: string): Promise<string[]> {
  const rows = (await q`
    SELECT id, fiscal_year, period FROM afs_documents
    WHERE company_id = ${companyId}::UUID
      AND status = 'partner_review'
      AND signing_requested_at IS NOT NULL
    ORDER BY signing_requested_at
  `) as Array<{ id: string; fiscal_year: number | null; period: string | null }>;
  return rows.map(row =>
    `AFS document ${row.id} (${row.fiscal_year ?? row.period ?? 'undated'}) is out for signature: `
    + `this change to ${what} will cause its signature to be refused, and it will have to be sent again.`);
}

/**
 * Records the refusal and hands the document back: staff can correct the content and send again.
 * The document keeps its own status — it is not moved by a signature it did not earn.
 */
export async function recordSignatureRefusal(
  q: Query,
  companyId: string,
  documentId: string,
  reason: string,
): Promise<void> {
  await q`
    UPDATE afs_documents
    SET signing_refused_at          = now(),
        signing_refused_reason      = ${reason},
        signum_document_id          = NULL,
        signing_requested_at        = NULL,
        signing_content_fingerprint = NULL,
        signing_payload_sha256      = NULL,
        signing_input_digests       = NULL,
        updated_at                  = now()
    WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  `;
  log.warn('Signature refused — the signed content is not the content held', { companyId, documentId, reason }, 'afsSigningIntegrity');
}
