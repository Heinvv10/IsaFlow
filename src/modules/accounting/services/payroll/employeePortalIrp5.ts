/**
 * The signed-in employee's own IRP5 certificates in the self-service portal (wave 6 SS-c; ruling of 2026-11-17: only
 * a tax year whose EMP501 version is FILED, built from that version's stored figures).
 *
 * Company and employee come from the verified portal session (employeePortalAuth), never from the request. A version
 * counts only when it is this company's EMP501 at status 'filed' (a superseded or merely finalised version never shows:
 * no draft figures). The certificate is found through the version's own `certificateEmployees` map (emp501Figures),
 * so an employee sees the certificate filed for their payroll record and nobody else's; a name or ID number is never
 * used to match. A version finalised before SS-c has no map and shows nothing. An ambiguous map (the employee named
 * twice, or a certificate number missing from the certificates) shows nothing, failing closed.
 *
 * Weekly and fortnightly pay: the IRP5 run-kind guard refuses those runs, so no filed EMP501 carries them; the
 * response says the employee's pay frequency so the page can say why nothing is there.
 */
import { sql } from '@/lib/neon';
import type { Emp501Figures } from '@/modules/accounting/services/returns/emp501Figures';
import { certificateView, type CertificateView } from './employeePortalIrp5View';

interface VersionRow { id: string; filed_at: string | Date | null; figures: Partial<Emp501Figures> }

export interface OwnCertificates { payFrequency: string; certificates: CertificateView[] }

function certificateOf(row: VersionRow, employeeId: string): CertificateView | null {
  const f = row.figures;
  const mine = (f.certificateEmployees ?? []).filter((m) => m.employeeId === employeeId);
  if (mine.length !== 1 || !f.employer || (f.kind !== 'interim' && f.kind !== 'annual') || typeof f.taxYear !== 'number') return null;
  const certs = (f.employees ?? []).filter((e) => e.certificateNumber === mine[0]!.certificateNumber);
  if (certs.length !== 1) return null;
  const filedAt = row.filed_at == null ? null : row.filed_at instanceof Date ? row.filed_at.toISOString() : String(row.filed_at);
  return certificateView({ id: row.id, filedAt, taxYear: f.taxYear, kind: f.kind }, f.employer, certs[0]!);
}

async function filedVersions(companyId: string, employeeId: string, versionId: string | null): Promise<VersionRow[]> {
  return (await sql`
    SELECT v.id::text AS id, v.filed_at, v.figures
      FROM tax_return_versions v
     WHERE v.company_id = ${companyId}::uuid AND v.form_type = 'EMP501' AND v.status = 'filed'
       AND v.figures -> 'certificateEmployees' @> jsonb_build_array(jsonb_build_object('employeeId', ${employeeId}::text))
       AND (${versionId}::uuid IS NULL OR v.id = ${versionId}::uuid)
     ORDER BY v.period_start DESC, v.period_end DESC
  `) as VersionRow[];
}

export async function listOwnCertificates(companyId: string, employeeId: string): Promise<OwnCertificates> {
  const emp = (await sql`
    SELECT pay_frequency FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as Array<{ pay_frequency: string }>;
  const rows = await filedVersions(companyId, employeeId, null);
  return {
    payFrequency: emp[0]?.pay_frequency ?? 'monthly',
    certificates: rows.map((r) => certificateOf(r, employeeId)).filter((c): c is CertificateView => c !== null),
  };
}

/** One of the employee's own certificates, or null (not theirs, not filed, not this company's: the same 404). */
export async function ownCertificate(companyId: string, employeeId: string, versionId: string): Promise<CertificateView | null> {
  const rows = await filedVersions(companyId, employeeId, versionId);
  return rows[0] ? certificateOf(rows[0], employeeId) : null;
}
