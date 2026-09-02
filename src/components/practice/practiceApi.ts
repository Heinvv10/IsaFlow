/**
 * Client-side fetchers for practice reference data (clients, job categories,
 * work items, entry templates, staff rates).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every practice screen used to unwrap `res.json()` by hand, and each one
 * guessed a different shape:
 *
 *   const json = await res.json() as { workItems?: WorkItem[] } | WorkItem[];
 *   setWorkItems(Array.isArray(json) ? json : (json.workItems ?? []));
 *
 * The API actually replies `{ success, data: WorkItem[] }`, so that expression
 * evaluated to `[]` on every call — a permanently empty, `required` Work Item
 * dropdown that made time entry impossible to submit. The same guess broke the
 * template picker and the rate preview. See `project_api_envelope_defect_class`.
 *
 * The `?? []` is what made it invisible: a shape mismatch rendered as "no data"
 * rather than an error. So every reader below goes through `apiJson` (which
 * throws `ApiEnvelopeError` on a non-`{ data }` body) and then through
 * `asArray`/`asObject`, which THROW rather than substitute an empty result.
 * A wrong shape now surfaces as a visible error banner, not a blank <select>.
 */

import { apiJson, apiFetch, assertOk, ApiRequestError } from '@/lib/apiFetch';
import type {
  JobCategory,
  WorkItem,
} from '@/modules/accounting/services/practice/practiceJobCategoryService';
import type { PracticeClient } from '@/modules/accounting/services/practice/practiceClientService';
import type {
  EntryTemplate,
  EntryTemplateInput,
} from '@/modules/accounting/services/practice/practiceEntryTemplateService';

export type { JobCategory, WorkItem, PracticeClient, EntryTemplate };

/** The list endpoints return a bare array as their `data`. */
function asArray<T>(data: unknown, what: string): T[] {
  if (!Array.isArray(data)) {
    throw new Error(`${what}: expected an array payload, got ${typeof data}`);
  }
  return data as T[];
}

/**
 * Read one required field off an object payload, refusing a silent `undefined`.
 * `expected` is checked too: presence alone would let a `null` or a string
 * through as if it were the declared type, which is the same
 * confirmed-but-wrong guess this module exists to stop.
 */
function asField<T>(
  data: unknown,
  field: string,
  what: string,
  expected: 'array' | 'number',
): T {
  if (typeof data !== 'object' || data === null || !(field in data)) {
    throw new Error(`${what}: payload has no '${field}' field`);
  }
  const value = (data as Record<string, unknown>)[field];
  const ok = expected === 'array' ? Array.isArray(value) : typeof value === 'number';
  if (!ok) {
    throw new Error(`${what}: '${field}' is not ${expected === 'array' ? 'an array' : 'a number'}`);
  }
  return value as T;
}

// ---------------------------------------------------------------- categories

export async function fetchJobCategories(includeInactive = false): Promise<JobCategory[]> {
  const data = await apiJson(
    `/api/accounting/practice/job-categories?includeInactive=${includeInactive}`,
  );
  return asArray<JobCategory>(data, 'job categories');
}

export async function createJobCategory(name: string): Promise<void> {
  const res = await apiFetch('/api/accounting/practice/job-categories', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  await assertOk(res, 'Failed to create category');
}

export async function setJobCategoryActive(id: string, isActive: boolean): Promise<void> {
  const res = await apiFetch(
    `/api/accounting/practice/job-categories/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify({ isActive }) },
  );
  await assertOk(res, 'Failed to update category');
}

// ---------------------------------------------------------------- work items

export async function fetchWorkItems(
  categoryId: string,
  includeInactive = false,
): Promise<WorkItem[]> {
  const data = await apiJson(
    `/api/accounting/practice/work-items?categoryId=${encodeURIComponent(categoryId)}` +
      `&includeInactive=${includeInactive}`,
  );
  return asArray<WorkItem>(data, 'work items');
}

export async function createWorkItem(
  categoryId: string,
  name: string,
  defaultBillable: boolean,
): Promise<void> {
  const res = await apiFetch('/api/accounting/practice/work-items', {
    method: 'POST',
    body: JSON.stringify({ categoryId, name, defaultBillable }),
  });
  await assertOk(res, 'Failed to create work item');
}

export async function setWorkItemActive(id: string, isActive: boolean): Promise<void> {
  const res = await apiFetch(
    `/api/accounting/practice/work-items/${encodeURIComponent(id)}`,
    { method: 'PUT', body: JSON.stringify({ isActive }) },
  );
  await assertOk(res, 'Failed to update work item');
}

// ------------------------------------------------------------------- clients

/**
 * `listPracticeClients` defaults to LIMIT 50. A picker that silently shows the
 * alphabetically-first 50 clients is a data-loss bug for any practice past that
 * size, so callers that populate a dropdown must ask for the full list.
 */
export const CLIENT_PICKER_LIMIT = 1000;

export async function fetchActiveClients(): Promise<PracticeClient[]> {
  const data = await apiJson(
    `/api/accounting/practice/clients?status=active&limit=${CLIENT_PICKER_LIMIT}`,
  );
  return asField<PracticeClient[]>(data, 'clients', 'practice clients', 'array');
}

// ----------------------------------------------------------------- templates

export async function fetchEntryTemplates(): Promise<EntryTemplate[]> {
  const data = await apiJson('/api/accounting/practice/entry-templates');
  return asField<EntryTemplate[]>(data, 'templates', 'entry templates', 'array');
}

export async function createEntryTemplate(input: EntryTemplateInput): Promise<void> {
  const res = await apiFetch('/api/accounting/practice/entry-templates', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  await assertOk(res, 'Failed to save template');
}

// ---------------------------------------------------------------------- rate

/**
 * Resolves the staff/client rate for a date. Returns `null` when the server
 * says 404 — "no rate configured" is an expected state the form renders as a
 * warning, not a failure. Any other error propagates.
 */
export async function resolveStaffRate(
  userId: string,
  clientId: string,
  date: string,
): Promise<number | null> {
  try {
    const data = await apiJson(
      `/api/accounting/practice/rate-resolve?userId=${encodeURIComponent(userId)}` +
        `&clientId=${encodeURIComponent(clientId)}&date=${encodeURIComponent(date)}`,
    );
    return asField<number>(data, 'rate', 'rate resolve', 'number');
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}
