/**
 * The request body of PUT /api/mcp/uploads/<token>, read with three stops so a client can neither make the server
 * buffer more than it declared nor hold the read open:
 *   - too_large: past `cap` bytes (the declared size) reading stops at once;
 *   - stalled: no data for uploadReadLimits.idleMs, or the whole body not in by uploadReadLimits.totalMs;
 *   - aborted: the client closed or errored the stream before it ended.
 * On any stop the listeners are dropped, the stream is paused (never drained: nothing past cap + 1 byte is pulled)
 * and nothing read is kept; the caller answers, closes the connection and stages nothing.
 */
import type { Readable } from 'stream';

/** Mutable for tests only. 10 MB at a slow 64 KB/s is ~160 s, inside the total. */
export const uploadReadLimits = { idleMs: 30_000, totalMs: 300_000 };

export type BodyStop = 'too_large' | 'stalled' | 'aborted';

export class UploadBodyError extends Error {
  constructor(readonly stop: BodyStop) {
    super(`upload body ${stop}`);
  }
}

export function readUploadBody(req: Readable, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const whole = setTimeout(() => stop('stalled'), uploadReadLimits.totalMs);

    const cleanup = () => {
      settled = true;
      clearTimeout(whole);
      if (idle) clearTimeout(idle);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
      req.removeListener('aborted', onClose);
    };
    const stop = (why: BodyStop) => {
      if (settled) return;
      cleanup();
      chunks.length = 0;
      req.pause();
      reject(new UploadBodyError(why));
    };
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => stop('stalled'), uploadReadLimits.idleMs);
    };
    function onData(chunk: Buffer) {
      if (settled) return;
      total += chunk.length;
      if (total > cap) { stop('too_large'); return; }
      chunks.push(chunk);
      armIdle();
    }
    function onEnd() {
      if (settled) return;
      cleanup();
      resolve(Buffer.concat(chunks));
    }
    function onError() { stop('aborted'); }
    function onClose() { stop('aborted'); }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
    req.on('aborted', onClose);
    armIdle();
  });
}
