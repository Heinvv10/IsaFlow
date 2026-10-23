import { apiFetch, assertOk } from '@/lib/apiFetch';
import { saveBlob } from '@/lib/saveBlob';
import { log } from '@/lib/logger';
import { templateUrl } from './templateUrl';

/** Fetches a migration CSV template and saves it; throws (via assertOk) with the server's message on a refusal. */
export async function downloadTemplate(url: string, filename: string): Promise<void> {
  const res = await apiFetch(url);
  await assertOk(res, 'Could not download the template - try again');
  saveBlob(await res.blob(), filename);
}

/** The active migration session's source system, or null when there is none. */
export async function fetchSessionSourceSystem(): Promise<string | null> {
  const res = await apiFetch('/api/accounting/migration/session');
  await assertOk(res, 'Could not load the migration session - try again');
  const json = await res.json() as { data?: { session?: { sourceSystem?: string | null } | null } };
  return json.data?.session?.sourceSystem ?? null;
}

/**
 * Downloads a wizard step's template for the session's source system. The
 * customer, supplier, opening-balance and invoice pages called the API with no
 * sourceSystem at all and got a validation error instead of a file.
 */
export async function downloadStepTemplate(step: string, sourceSystem?: string | null): Promise<void> {
  let source = sourceSystem ?? null;
  if (sourceSystem === undefined) {
    // The session only picks the template's flavour; failing to read it must
    // not cost the operator the template. The generic one is always valid.
    try {
      source = await fetchSessionSourceSystem();
    } catch (err) {
      log.warn('Could not read the migration session for the template; using the generic template', { error: err }, 'migration');
    }
  }
  await downloadTemplate(templateUrl(step, source), `isaflow-${step}-template.csv`);
}
