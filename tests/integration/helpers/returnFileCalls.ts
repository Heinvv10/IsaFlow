/**
 * Calls and row readers shared by tax-return-file-amend and tax-return-file-guards (wave 5 L1b): the real route handlers
 * (withAuth, CSRF, write access) for finalise, file, amend, the legacy mark-submitted route and the VAT unlock.
 * `useFixture` names the suite's company.
 */
import { sql } from '@/lib/neon';
import { callRoute, count, type ReturnFixture } from './returnVersionsFixture';
import finalise from '../../../pages/api/accounting/sars/returns/[form]/finalise';
import file from '../../../pages/api/accounting/sars/returns/[form]/file';
import amend from '../../../pages/api/accounting/sars/returns/[form]/amend';
import filingFile from '../../../pages/api/accounting/sars/returns/[form]/filing-file';
import legacySubmissions from '../../../pages/api/accounting/sars/sars-submissions';

type Row = Record<string, unknown>;

// The fixture company files bi-monthly, periods ending in odd months (Category A).
export const CLEAN = { periodStart: '2026-02-01', periodEnd: '2026-03-31' };
export const DIRTY = { periodStart: '2026-04-01', periodEnd: '2026-05-31' };
export const INVISIBLE = [0x200b, 0x200c, 0x200d, 0xfeff, 0x00a0].map((c) => String.fromCharCode(c)).join(' ');
export const SWAPPED = { periodStart: '2026-08-01', periodEnd: '2026-09-30' };
let rf: ReturnFixture | null = null;
export function useFixture(f: ReturnFixture): void { rf = f; }
function fx(): ReturnFixture {
  if (!rf) throw new Error('useFixture first');
  return rf;
}
export const c = () => fx().fx.companyId;
export const fin = (p: typeof CLEAN, extra: Record<string, unknown> = {}, token = fx().admin.token) =>
  callRoute(finalise, c(), token, 'POST', { form: 'vat201' }, { ...p, ...extra });
/** A SARS payment reference number of the shape the filing route accepts (wave 6 EFa, filingReference.ts). */
export const PRN = (form: string, n = 1) => `${form === 'emp201' ? '7' : '4'}123456789${form === 'emp201' ? 'L' : 'V'}${String(n).padStart(8, '0')}`;
/** Downloads (and so, the first time, stamps) a version's filing file as the admin. */
export const genFile = (id: string, form = 'vat201', format = 'csv', token = fx().admin.token) =>
  callRoute(filingFile, c(), token, 'POST', { form }, { versionId: id, format });
/** Files a version as EFa requires: its filing file downloaded first (as the admin), unless `withoutFile`. */
export const fileV = async (id: string, body: Record<string, unknown> = {}, token = fx().admin.token, form = 'vat201') => {
  const { withoutFile, ...rest } = body;
  if (withoutFile !== true) await genFile(id, form);
  return callRoute(file, c(), token, 'POST', { form }, { versionId: id, reference: PRN(form), ...rest });
};
export const amendV = (id: string, body: Record<string, unknown> = { reason: 'Corrected a bill' }, token = fx().admin.token, form = 'vat201') =>
  callRoute(amend, c(), token, 'POST', { form }, { versionId: id, ...body });
export const versionOf = (r: { body: Row }) => (r.body as { data: { version: Row } }).data.version;
export const row = async (id: string) => ((await sql`SELECT * FROM tax_return_versions WHERE id = ${id}::UUID`) as Row[])[0]!;
export const submissions = async () =>
  Number(((await sql`SELECT COUNT(*)::INT AS n FROM sars_submissions WHERE company_id = ${c()}::UUID`) as Row[])[0]!.n);
/** A version's filing and amend audit rows; the filing-file stamp's own row (EFa) is left out (w6-efa-filing-file.int). */
export const audits = async (versionId: string) => (await sql`SELECT action, changes FROM audit_log WHERE company_id = ${c()}::UUID
  AND entity_type = 'tax_return_version' AND entity_id = ${versionId}::UUID
  AND COALESCE(changes #>> '{fields,0,field}', '') <> 'filing_file_sha256' ORDER BY created_at`) as Row[];
export const legacy = (id: string, reference = 'LEGACY-1') =>
  callRoute(legacySubmissions, c(), fx().admin.token, 'POST', {}, { id, action: 'mark_submitted', reference });
export const draftRow = async (formType: string, start: string, end: string, status = 'draft') => String(((await sql`INSERT INTO sars_submissions
  (company_id, form_type, period_start, period_end, status) VALUES (${c()}::UUID, ${formType}, ${start}::DATE, ${end}::DATE, ${status})
  RETURNING id`) as Row[])[0]!.id);
export const overrides = () => count('vat_gate_overrides', c());
export const lockActive = async (id: string) =>
  ((await sql`SELECT unlocked_at FROM vat_period_locks WHERE id = ${id}::UUID`) as Row[])[0]!.unlocked_at == null;
