/**
 * The budget workspace's fetchers (spec §4.4, §7; PR-B contract). `apiFetch` RESOLVES on 4xx, so
 * every call returns an `ApiResult`: data, or a typed failure the UI switches on (409 stale /
 * locked, 429, 503, 400 naming the account). Nothing here throws on a status or a dropped
 * connection. The token is the `updatedAt` text exactly as the server sent it.
 *
 * A commit bigger than one save request (an import) is CHAINED by `saveChained`: clears first,
 * MAX_SAVE_CELLS a request, each chunk sent with the token the previous save returned, stopping
 * at the first refusal (non-atomic: the chunks before it stay saved, and the result says so).
 */
import { apiFetch } from '@/lib/apiFetch';
import type { ResponseFor } from '@/lib/apiRoutes';
import type { MAX_SAVE_CELLS as SERVER_MAX_SAVE_CELLS, SaveCell } from '@/modules/accounting/services/budgets/gridSaveValidate';
import type { SaveCellsResult } from '@/modules/accounting/services/budgets/gridSave';
import type { GridCellsOnly, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PriorActuals, PriorGrain } from '@/modules/accounting/services/budgets/priorActuals';
import type { SeedResult, SeedSource } from '@/modules/accounting/services/budgets/seedVersion';
import type { ImportPreview } from '@/modules/accounting/services/budgets/budgetImportDiff';
import type { BudgetVersionKind } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { ApiFailure, ApiResult, BudgetVersion, BudgetVersionStatus } from './types';

export type { SaveCell, PriorGrain };

/** The server's per-request cap; the type ties it to PR-B's constant (a change there fails tsc here). */
export const MAX_SAVE_CELLS: typeof SERVER_MAX_SAVE_CELLS = 20_000;

interface ErrorBody { message?: string; error?: { message?: string; details?: { code?: unknown; currentUpdatedAt?: unknown; status?: unknown } } }

const retryAfterOf = (res: Response): number | null => {
  const n = Number(res.headers.get('Retry-After'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** A non-2xx response (its body text already read) as a typed failure. */
function failureOf(res: Response, text: string, fallback: string): ApiFailure {
  let body: ErrorBody | null = null;
  try {
    body = JSON.parse(text) as ErrorBody;
  } catch {
    body = null; // an HTML error page or an empty body: the fallback sentence speaks for it
  }
  const message = body?.error?.message || body?.message || fallback;
  const details = body?.error?.details;
  const code = typeof details?.code === 'string' ? details.code : null;
  switch (res.status) {
    case 409:
      if (code === 'BUDGET_VERSION_STALE' && typeof details?.currentUpdatedAt === 'string') {
        return { ok: false, kind: 'stale', message, currentUpdatedAt: details.currentUpdatedAt, versionStatus: details.status as BudgetVersionStatus };
      }
      if (code === 'BUDGET_VERSION_LOCKED') return { ok: false, kind: 'locked', message };
      return { ok: false, kind: 'conflict', message, code };
    case 429: return { ok: false, kind: 'rateLimited', message, retryAfter: retryAfterOf(res) };
    case 503: return { ok: false, kind: 'busy', message, retryAfter: retryAfterOf(res) };
    case 400: case 413: case 422: return { ok: false, kind: 'invalid', message, code };
    case 403: return { ok: false, kind: 'forbidden', message };
    case 404: return { ok: false, kind: 'notFound', message };
    default: return { ok: false, kind: 'failed', message, status: res.status };
  }
}

/** One request, as an ApiResult typed by the route registry. */
async function call<U extends string>(url: U, init: RequestInit | undefined, fallback: string): Promise<ApiResult<ResponseFor<U>>> {
  let res: Response;
  try {
    res = await apiFetch(url, init);
  } catch {
    return { ok: false, kind: 'network', message: fallback };
  }
  if (!res.ok) return failureOf(res, await res.text(), fallback);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    parsed = null; // a 2xx that is not JSON (a proxy page) is not the data
  }
  if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) return { ok: false, kind: 'failed', message: fallback, status: res.status };
  return { ok: true, data: (parsed as { data: ResponseFor<U> }).data };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** Narrows a union answer to the member the caller asked for; anything else is a failed result. */
function narrow<T, N extends T>(r: ApiResult<T>, is: (d: T) => d is N, fallback: string): ApiResult<N> {
  if (!r.ok) return r;
  return is(r.data) ? { ok: true, data: r.data } : { ok: false, kind: 'failed', message: fallback, status: 200 };
}

// ── Grid ─────────────────────────────────────────────────────────────────────

export type GridSelection = { versionId: string } | { fiscalYear: number };

export async function fetchGridModel(sel: GridSelection): Promise<ApiResult<GridReadModel>> {
  const fallback = 'Could not load the budget.';
  const r = 'versionId' in sel
    ? await call(`/api/accounting/budget-grid?version_id=${encodeURIComponent(sel.versionId)}`, undefined, fallback)
    : await call(`/api/accounting/budget-grid?fiscal_year=${sel.fiscalYear}`, undefined, fallback);
  return narrow(r, (d): d is GridReadModel => 'accounts' in d, fallback);
}

/** The compare version's cells (`cells_only=1`). */
export async function fetchGridCells(versionId: string): Promise<ApiResult<GridCellsOnly>> {
  const fallback = 'Could not load the version to compare with.';
  const r = await call(`/api/accounting/budget-grid?version_id=${encodeURIComponent(versionId)}&cells_only=1`, undefined, fallback);
  return narrow(r, (d): d is GridCellsOnly => !('accounts' in d), fallback);
}

export function fetchPriorActuals(fiscalYear: number, grain: PriorGrain): Promise<ApiResult<PriorActuals>> {
  return call(`/api/accounting/budget-grid/prior-actuals?fiscal_year=${fiscalYear}&grain=${grain}`,
    undefined, 'Could not load the prior-year actuals.');
}

/** One save request (≤ MAX_SAVE_CELLS cells). A delete carries `amount: null, clear: true`. */
export function saveCells(versionId: string, expectedUpdatedAt: string, cells: readonly SaveCell[]): Promise<ApiResult<SaveCellsResult>> {
  return call('/api/accounting/budget-grid/save', post({ versionId, expectedUpdatedAt, cells }), 'Could not save the budget.');
}

export type ChainResult =
  | { ok: true; updatedAt: string; saved: number; deleted: number; chunks: number }
  | {
    ok: false; failure: ApiFailure;
    /** 0-based index of the refused chunk; the chunks before it were saved. */
    failedChunk: number; chunks: number;
    /** The cells the saved chunks carried. */
    committed: SaveCell[];
    /** The token after the last saved chunk (the given token when none was). */
    updatedAt: string; saved: number; deleted: number;
  };

export async function saveChained(versionId: string, cells: readonly SaveCell[], token: string): Promise<ChainResult> {
  // Clears first, so a grain change split over chunks never meets the one-grain rule half done.
  const ordered = [...cells.filter(c => c.clear === true), ...cells.filter(c => c.clear !== true)];
  const chunks = Math.ceil(ordered.length / MAX_SAVE_CELLS);
  let updatedAt = token;
  let saved = 0;
  let deleted = 0;
  for (let i = 0; i < chunks; i++) {
    const r = await saveCells(versionId, updatedAt, ordered.slice(i * MAX_SAVE_CELLS, (i + 1) * MAX_SAVE_CELLS));
    if (!r.ok) return { ok: false, failure: r, failedChunk: i, chunks, committed: ordered.slice(0, i * MAX_SAVE_CELLS), updatedAt, saved, deleted };
    updatedAt = r.data.updatedAt;
    saved += r.data.saved;
    deleted += r.data.deleted;
  }
  return { ok: true, updatedAt, saved, deleted, chunks };
}

export interface SeedRequest {
  fiscalYear: number;
  name: string;
  kind: BudgetVersionKind;
  makePrimary: boolean;
  source: SeedSource;
  roundingUnit: RoundingUnit;
  includeNoActivity?: boolean;
}

export function seedVersion(req: SeedRequest): Promise<ApiResult<SeedResult>> {
  return call('/api/accounting/budget-grid/seed', post(req), 'Could not create the budget.');
}

// ── Excel ────────────────────────────────────────────────────────────────────

export function templateUrl(versionId: string, grain: PriorGrain, members?: readonly string[]): string {
  const q = new URLSearchParams({ version_id: versionId, grain });
  if (members && members.length > 0) q.set('members', members.join(','));
  return `/api/accounting/budget-grid/template?${q.toString()}`;
}

/** The template as a Blob (through apiFetch, so the company header and the 401 refresh apply). */
export async function downloadTemplate(versionId: string, grain: PriorGrain, members?: readonly string[]): Promise<ApiResult<{ blob: Blob; fileName: string }>> {
  const fallback = 'Could not download the budget template.';
  let res: Response;
  try {
    res = await apiFetch(templateUrl(versionId, grain, members));
  } catch {
    return { ok: false, kind: 'network', message: fallback };
  }
  if (!res.ok) return failureOf(res, await res.text(), fallback);
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'budget-template.xlsx';
  return { ok: true, data: { blob: await res.blob(), fileName: name } };
}

/** Standard padded base64 of the file's bytes (what the import route reads), no `data:` prefix. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function previewImport(versionId: string, file: File): Promise<ApiResult<ImportPreview>> {
  const fileData = await fileToBase64(file);
  return call('/api/accounting/budget-grid/import-preview', post({ versionId, fileName: file.name, fileData }), 'Could not read the budget file.');
}

// ── Versions (P1 routes) ─────────────────────────────────────────────────────

export async function listVersions(fiscalYear: number): Promise<ApiResult<BudgetVersion[]>> {
  const fallback = 'Could not load the budget versions.';
  const r = await call(`/api/accounting/budget-versions?fiscalYear=${fiscalYear}`, undefined, fallback);
  const list = narrow(r, (d): d is { items: BudgetVersion[] } => 'items' in d, fallback);
  return list.ok ? { ok: true, data: list.data.items } : list;
}

export type VersionAction = 'approve' | 'lock' | 'unlock';

export async function setVersionStatus(
  id: string, action: VersionAction, opts: { reason?: string; expectedUpdatedAt?: string } = {},
): Promise<ApiResult<BudgetVersion>> {
  return call(`/api/accounting/budget-versions/${encodeURIComponent(id)}/status`,
    post({ action, ...opts }), 'Could not change the budget status.');
}

export function setPrimaryVersion(id: string): Promise<ApiResult<BudgetVersion>> {
  return call(`/api/accounting/budget-versions/${encodeURIComponent(id)}/primary`,
    post({}), 'Could not make this the primary budget.');
}

export async function deleteVersion(id: string): Promise<ApiResult<{ deleted: true }>> {
  const fallback = 'Could not delete the budget version.';
  const r = await call(`/api/accounting/budget-versions/${encodeURIComponent(id)}`, { method: 'DELETE' }, fallback);
  return narrow(r, (d): d is { deleted: true } => 'deleted' in d, fallback);
}

export function copyVersion(id: string, body: { name: string; kind: BudgetVersionKind }): Promise<ApiResult<BudgetVersion>> {
  return call(`/api/accounting/budget-versions/${encodeURIComponent(id)}/copy`,
    post(body), 'Could not copy the budget version.');
}
