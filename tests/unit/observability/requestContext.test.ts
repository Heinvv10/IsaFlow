import { describe, it, expect } from 'vitest';
import { runWithRequestContext, getRequestId, generateRequestId } from '@/lib/observability/requestContext';
import { log } from '@/lib/logger';

describe('requestContext', () => {
  it('returns undefined outside a context', () => {
    expect(getRequestId()).toBeUndefined();
  });

  it('exposes the requestId inside runWithRequestContext', async () => {
    await runWithRequestContext('rid-123', async () => {
      expect(getRequestId()).toBe('rid-123');
    });
  });

  it('propagates across async boundaries', async () => {
    await runWithRequestContext('rid-async', async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getRequestId()).toBe('rid-async');
      await Promise.resolve();
      expect(getRequestId()).toBe('rid-async');
    });
  });

  it('isolates contexts across parallel calls', async () => {
    const results = await Promise.all([
      runWithRequestContext('rid-A', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getRequestId();
      }),
      runWithRequestContext('rid-B', async () => {
        await new Promise((r) => setTimeout(r, 2));
        return getRequestId();
      }),
    ]);
    expect(results).toEqual(['rid-A', 'rid-B']);
  });

  it('returns undefined after the context exits', async () => {
    await runWithRequestContext('rid-exit', async () => {});
    expect(getRequestId()).toBeUndefined();
  });

  it('generateRequestId returns a ULID-shaped string', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('logger requestId stamping', () => {
  it('stamps requestId into stdout log lines inside a context', async () => {
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      written.push(String(chunk));
      return true;
    };
    try {
      await runWithRequestContext('rid-stamped', async () => {
        log.info('hello', { x: 1 }, 'test');
      });
    } finally {
      (process.stdout as any).write = origWrite;
    }
    const parsed = written.map((l) => JSON.parse(l.trim()));
    expect(parsed.some((p) => p.requestId === 'rid-stamped' && p.message === 'hello')).toBe(true);
  });

  it('omits requestId outside a context', async () => {
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (chunk: any) => {
      written.push(String(chunk));
      return true;
    };
    try {
      log.info('no-context', { y: 2 }, 'test');
    } finally {
      (process.stdout as any).write = origWrite;
    }
    const parsed = written.map((l) => JSON.parse(l.trim()));
    const match = parsed.find((p) => p.message === 'no-context');
    expect(match).toBeDefined();
    expect('requestId' in match!).toBe(false);
  });
});
