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
  /**
   * The server's refusal code when it named one: SEND_UNCERTAIN, LEGACY_SUBMISSION_EXISTS, RATE_CHECK_FAILED,
   * VAT_RETURN_MISMATCH, LIVE_VERSION_EXISTS, OVERLAPS_LIVE_VERSION, IMPERSONATION_FORBIDDEN.
   */
  code: string | null;
  /** LEGACY_SUBMISSION_EXISTS: exactly the submissions the filing must name, as the server locked them. */
  legacySubmissionIds: string[] | null;
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
  error?: {
    message?: string; code?: string;
    details?: { code?: string; reason?: string; counts?: VatGateCounts; legacySubmissionIds?: string[] };
  };
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
      legacySubmissionIds: json?.error?.details?.legacySubmissionIds ?? null,
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
