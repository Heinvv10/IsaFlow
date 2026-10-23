/**
 * Wait for a Scan & Fill job: poll GET /api/accounting/vlm-extract?job= every 2 s for up to 10 minutes.
 * A poll that gets no answer (5xx, dropped connection) is retried: the read goes on in the background.
 * Resolves to the extraction, or to null when `cancel()` was called (the page went away).
 * Rejects with a message fit for a toast: the job failed, is unknown (404: server restarted or expired), or took too long.
 */
import { apiFetch, ApiEnvelopeError, assertOk } from '@/lib/apiFetch';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

export const SCAN_POLL_INTERVAL_MS = 2000;
export const SCAN_MAX_WAIT_MS = 10 * 60_000;

interface JobAnswer {
  state: 'reading' | 'done' | 'failed';
  extracted?: ExtractedDocument;
  error?: string;
}

async function readJob(jobId: string): Promise<JobAnswer | 'retry'> {
  let res: Response;
  try {
    res = await apiFetch(`/api/accounting/vlm-extract?job=${encodeURIComponent(jobId)}`);
  } catch {
    return 'retry'; // dropped connection
  }
  if (res.status === 404) throw new ApiEnvelopeError('The scan was interrupted — try again.');
  if (res.status >= 500) return 'retry';
  await assertOk(res, 'Could not check the scan - try again');
  const json = await res.json() as { data?: JobAnswer };
  if (!json.data) throw new ApiEnvelopeError('Could not check the scan - try again');
  return json.data;
}

export function pollScanJob(jobId: string): { result: Promise<ExtractedDocument | null>; cancel: () => void } {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: () => void = () => undefined;
  const sleep = () => new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, SCAN_POLL_INTERVAL_MS); });

  async function run(): Promise<ExtractedDocument | null> {
    const deadline = Date.now() + SCAN_MAX_WAIT_MS;
    try {
      while (!cancelled) {
        await sleep();
        if (cancelled) return null;
        const answer = await readJob(jobId);
        if (cancelled) return null;
        if (answer !== 'retry') {
          if (answer.state === 'done' && answer.extracted) return answer.extracted;
          if (answer.state === 'failed') throw new ApiEnvelopeError(answer.error || 'Could not read this document - try again');
        }
        if (Date.now() >= deadline) throw new ApiEnvelopeError('The scan is taking too long — try again.');
      }
      return null;
    } catch (err) {
      if (cancelled) return null; // the page went away: nobody is left to tell
      throw err;
    }
  }

  return {
    result: run(),
    cancel: () => { cancelled = true; if (timer) clearTimeout(timer); wake(); },
  };
}

