/**
 * Client calls for the tax return lifecycle (wave 5 L2) on /api/accounting/sars/returns/[form]/*.
 * A refusal is returned, never thrown, with the server's own message, status, refusal code and
 * VAT gate counts, so the caller can show it and offer the matching next step.
 */
import { apiFetch, assertOk } from '@/lib/apiFetch';
import type { ReturnVersionView } from '@/modules/accounting/services/returns/returnDrift';
import type { ReturnForm, VatReturnRecord } from '@/modules/accounting/services/returns/returnVersionTypes';
import type { VatGateCounts } from '../VatGateOverrideBox';

export type { ReturnVersionView, ReturnForm, VatReturnRecord };
export type ReturnAction = 'finalise' | 'file' | 'amend';

export interface ReturnVersions { versions: ReturnVersionView[]; vatReturn: VatReturnRecord | null }

export interface ReturnRefusalInfo {
  status: number;
  message: string;
  /** SEND_UNCERTAIN, LEGACY_SUBMISSION_EXISTS, IMPERSONATION_FORBIDDEN ..., when the server named one. */
  code: string | null;
  /** The VAT exceptions gate's blocking counts (a 400 from finalise or file). */
  counts: VatGateCounts | null;
}

export type ReturnActionResult = { ok: true } | { ok: false; refusal: ReturnRefusalInfo };

const slug = (form: ReturnForm): string => form.toLowerCase();

export async function loadReturnVersions(form: ReturnForm, periodStart: string, periodEnd: string): Promise<ReturnVersions> {
  const q = new URLSearchParams({ periodStart, periodEnd });
  const res = await apiFetch(`/api/accounting/sars/returns/${slug(form)}/versions?${q}`, { credentials: 'include' });
  await assertOk(res, 'Could not load the return versions - try again');
  const json = await res.json() as { data: ReturnVersions };
  return json.data;
}

interface ErrorBody {
  message?: string;
  error?: { message?: string; code?: string; details?: { code?: string; reason?: string; counts?: VatGateCounts } };
}

export async function postReturnAction(
  form: ReturnForm, action: ReturnAction, body: Record<string, unknown>,
): Promise<ReturnActionResult> {
  const res = await apiFetch(`/api/accounting/sars/returns/${slug(form)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true };
  let json: ErrorBody | null = null;
  try { json = JSON.parse(await res.text()) as ErrorBody; } catch { json = null; /* a non-JSON body: the fallback below says so */ }
  const fieldErrors = json?.error?.details && !json.error.details.code && !json.error.details.reason && !json.error.details.counts
    ? Object.values(json.error.details as Record<string, unknown>).flat().filter((m): m is string => typeof m === 'string') : [];
  const message = json?.error?.message || json?.message || 'The return could not be updated. Reload the page and try again.';
  return {
    ok: false,
    refusal: {
      status: res.status,
      message: fieldErrors.length > 0 ? `${message}: ${fieldErrors.join('; ')}` : message,
      code: json?.error?.details?.code ?? json?.error?.details?.reason ?? null,
      counts: json?.error?.details?.counts ?? null,
    },
  };
}

/** Company members' names by user id, for "who" on each step. */
export async function loadMemberNames(): Promise<Map<string, string>> {
  const res = await apiFetch('/api/accounting/company-users', { credentials: 'include' });
  await assertOk(res, 'Could not load the company members');
  const json = await res.json() as { data: Array<{ userId: string; name: string }> };
  return new Map(json.data.map((u) => [u.userId, u.name]));
}

/**
 * The period's submissions filed the legacy way (submitted or accepted, overlapping the period, named by no version
 * here): the ids a filing must name to supersede them (409 LEGACY_SUBMISSION_EXISTS). The server re-checks the set.
 */
export async function loadLegacySubmissionIds(
  form: ReturnForm, periodStart: string, periodEnd: string, versions: ReturnVersionView[],
): Promise<string[]> {
  const res = await apiFetch(`/api/accounting/sars/sars-submissions?type=${form}`, { credentials: 'include' });
  await assertOk(res, 'Could not load the earlier filings for this period');
  const json = await res.json() as { data: { items: Array<{ id: string; status: string; periodStart: string; periodEnd: string }> } };
  const named = new Set(versions.map((v) => v.sarsSubmissionId).filter((id): id is string => id !== null));
  return json.data.items
    .filter((s) => (s.status === 'submitted' || s.status === 'accepted') && !named.has(s.id)
      && s.periodStart <= periodEnd && s.periodEnd >= periodStart)
    .map((s) => s.id);
}
