import { apiFetch, assertOk } from '@/lib/apiFetch';
import { saveBlob } from '@/lib/saveBlob';

/** Fetches a migration CSV template and saves it; throws (via assertOk) with the server's message on a refusal. */
export async function downloadTemplate(url: string, filename: string): Promise<void> {
  const res = await apiFetch(url);
  await assertOk(res, 'Could not download the template - try again');
  saveBlob(await res.blob(), filename);
}
