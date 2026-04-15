import { describe, it, expect } from 'vitest';
import { runWithRequestContext, getRequestId, generateRequestId } from '@/lib/observability/requestContext';

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
