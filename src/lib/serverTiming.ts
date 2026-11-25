/**
 * Server-Timing for a response: `timed(res, 'query', () => ...)` runs the step and records its wall time; the
 * header is written as each step ends, so the browser (and a curl -D) shows where a slow request spent it.
 * Numbers only, no data: safe on any authenticated route.
 */
import type { NextApiResponse } from 'next';

const marks = new WeakMap<object, string[]>();

export function recordTiming(res: NextApiResponse, name: string, ms: number): void {
  if (res.headersSent) return;
  const list = marks.get(res) ?? [];
  list.push(`${name};dur=${ms.toFixed(1)}`);
  marks.set(res, list);
  res.setHeader('Server-Timing', list.join(', '));
}

export async function timed<T>(res: NextApiResponse, name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    recordTiming(res, name, performance.now() - t0);
  }
}
