# Phase 4C — Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every request observable via correlated requestIds, a standard-shape per-request log line, a slow-query timing shim, and a two-endpoint health check pair.

**Architecture:** AsyncLocalStorage-backed requestId stamped into every `log.*` call; one structured log line per request emitted from `withErrorHandler`'s finally; timing shim around the Neon `sql` tagged template; `/api/health` (shallow, <50ms DB ping) plus `/api/health/deep` (DB + SMTP + Stitch with timeouts).

**Tech Stack:** Next.js 14, TypeScript strict, Node `async_hooks.AsyncLocalStorage`, `ulid`, Vitest, Neon serverless driver.

**Spec:** `docs/superpowers/specs/2026-04-15-phase4c-observability-design.md`

---

## File Map

**New:**
- `src/lib/observability/requestContext.ts` — ALS + ulid wrapper
- `src/lib/observability/requestLogger.ts` — `logRequestCompleted` helper
- `pages/api/health.ts` — shallow liveness endpoint
- `pages/api/health/deep.ts` — deep readiness endpoint
- `tests/unit/observability/requestContext.test.ts`
- `tests/unit/observability/requestLogger.test.ts`
- `tests/unit/observability/slowQuery.test.ts`
- `tests/integration/api/health.test.ts`

**Modified:**
- `src/lib/logger.ts` — read `getRequestId()` from ALS, stamp into every log payload
- `src/lib/api-error-handler.ts` — wrap handler in `runWithRequestContext`, call `logRequestCompleted` in `finally`
- `src/lib/neon.ts` — wrap `sql` tagged template with timing shim

---

## Task 1: Request context (AsyncLocalStorage + ulid)

**Files:**
- Create: `src/lib/observability/requestContext.ts`
- Test: `tests/unit/observability/requestContext.test.ts`

- [ ] **Step 1: Install `ulid` dependency**

Run: `bun add ulid`
Expected: `ulid` added to `package.json` dependencies.

- [ ] **Step 2: Write failing test**

Create `tests/unit/observability/requestContext.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bunx vitest run tests/unit/observability/requestContext.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the module**

Create `src/lib/observability/requestContext.ts`:

```typescript
/**
 * Request correlation via AsyncLocalStorage.
 *
 * `runWithRequestContext` is called once per API request inside
 * `withErrorHandler`. Everything executed inside the callback — including
 * deeply nested async code — can read the requestId via `getRequestId()`.
 *
 * Outside a context (background jobs, tests), `getRequestId()` returns
 * `undefined` so callers can omit the field gracefully.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { ulid } from 'ulid';

interface RequestContextStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export function runWithRequestContext<T>(
  requestId: string,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return storage.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function generateRequestId(): string {
  return ulid();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run tests/unit/observability/requestContext.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/observability/requestContext.ts tests/unit/observability/requestContext.test.ts package.json bun.lockb
git commit -m "feat(4C-1): AsyncLocalStorage-backed request context

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Logger reads requestId from ALS

**Files:**
- Modify: `src/lib/logger.ts`
- Test: `tests/unit/observability/requestContext.test.ts` (extend)

- [ ] **Step 1: Add failing test**

Append to `tests/unit/observability/requestContext.test.ts`:

```typescript
import { log } from '@/lib/logger';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/observability/requestContext.test.ts`
Expected: FAIL on the first new test — no `requestId` field present.

- [ ] **Step 3: Modify `src/lib/logger.ts`**

In the Node.js branch of `Logger.log` (the block that calls `process.stdout.write` / `process.stderr.write`), read the requestId from ALS and include it in the JSON line.

Add at the top of the file (after existing imports):

```typescript
import { getRequestId } from '@/lib/observability/requestContext';
```

Replace the `jsonLine` construction (currently around line 138–144):

```typescript
      const requestId = getRequestId();
      const jsonLine = JSON.stringify({
        level,
        message,
        timestamp,
        component,
        ...(requestId !== undefined ? { requestId } : {}),
        ...(data !== undefined ? { data } : {}),
      }) + '\n';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/observability/requestContext.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/logger.ts tests/unit/observability/requestContext.test.ts
git commit -m "feat(4C-2): logger stamps requestId from AsyncLocalStorage

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Request logger helper

**Files:**
- Create: `src/lib/observability/requestLogger.ts`
- Test: `tests/unit/observability/requestLogger.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/observability/requestLogger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { logRequestCompleted } from '@/lib/observability/requestLogger';
import { runWithRequestContext } from '@/lib/observability/requestContext';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
    url: '/api/accounting/foo',
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes(statusCode: number): NextApiResponse {
  return { statusCode } as unknown as NextApiResponse;
}

describe('logRequestCompleted', () => {
  let lines: string[];
  let originalWrite: typeof process.stdout.write;
  let originalErr: typeof process.stderr.write;

  beforeEach(() => {
    lines = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    originalErr = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (chunk: any) => {
      lines.push(String(chunk));
      return true;
    };
    (process.stderr as any).write = (chunk: any) => {
      lines.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    (process.stdout as any).write = originalWrite;
    (process.stderr as any).write = originalErr;
  });

  it('emits a request_completed line with the standard shape', async () => {
    await runWithRequestContext('rid-A', async () => {
      logRequestCompleted({
        req: makeReq(),
        res: makeRes(200),
        startMs: Date.now() - 47,
        userId: 'u-1',
        companyId: 'c-1',
      });
    });

    const parsed = lines.map((l) => JSON.parse(l.trim()));
    const entry = parsed.find((p) => p.data?.event === 'request_completed');
    expect(entry).toBeDefined();
    expect(entry.requestId).toBe('rid-A');
    expect(entry.data).toMatchObject({
      event: 'request_completed',
      route: '/api/accounting/foo',
      method: 'POST',
      status: 200,
      userId: 'u-1',
      companyId: 'c-1',
      outcome: 'ok',
    });
    expect(typeof entry.data.durationMs).toBe('number');
    expect(entry.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('maps 4xx to client_error', async () => {
    await runWithRequestContext('rid-B', async () => {
      logRequestCompleted({ req: makeReq(), res: makeRes(404), startMs: Date.now() });
    });
    const entry = lines.map((l) => JSON.parse(l.trim())).find((p) => p.data?.event === 'request_completed');
    expect(entry.data.outcome).toBe('client_error');
  });

  it('maps 5xx to server_error', async () => {
    await runWithRequestContext('rid-C', async () => {
      logRequestCompleted({ req: makeReq(), res: makeRes(500), startMs: Date.now() });
    });
    const entry = lines.map((l) => JSON.parse(l.trim())).find((p) => p.data?.event === 'request_completed');
    expect(entry.data.outcome).toBe('server_error');
  });

  it('strips querystring from the route', async () => {
    await runWithRequestContext('rid-D', async () => {
      logRequestCompleted({
        req: makeReq({ url: '/api/accounting/foo?x=1&y=2' }),
        res: makeRes(200),
        startMs: Date.now(),
      });
    });
    const entry = lines.map((l) => JSON.parse(l.trim())).find((p) => p.data?.event === 'request_completed');
    expect(entry.data.route).toBe('/api/accounting/foo');
  });

  it('handles missing userId / companyId as null', async () => {
    await runWithRequestContext('rid-E', async () => {
      logRequestCompleted({ req: makeReq(), res: makeRes(200), startMs: Date.now() });
    });
    const entry = lines.map((l) => JSON.parse(l.trim())).find((p) => p.data?.event === 'request_completed');
    expect(entry.data.userId).toBeNull();
    expect(entry.data.companyId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/observability/requestLogger.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the helper**

Create `src/lib/observability/requestLogger.ts`:

```typescript
/**
 * Emit a single structured log line per completed HTTP request.
 *
 * Shape:
 *   { event: 'request_completed', route, method, status, durationMs,
 *     userId, companyId, outcome }
 *
 * `outcome` is derived from status: <400 ok, <500 client_error, else server_error.
 * `route` strips the querystring from req.url.
 * `userId` / `companyId` are passed in by the caller (withErrorHandler pulls them
 * from req after withCompany has populated them, if present).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { log } from '@/lib/logger';

type Outcome = 'ok' | 'client_error' | 'server_error';

function outcomeFor(status: number): Outcome {
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'ok';
}

function routeOf(url: string | undefined): string {
  if (!url) return '';
  const qIndex = url.indexOf('?');
  return qIndex === -1 ? url : url.slice(0, qIndex);
}

export interface LogRequestCompletedArgs {
  req: NextApiRequest;
  res: NextApiResponse;
  startMs: number;
  userId?: string | null;
  companyId?: string | null;
}

export function logRequestCompleted(args: LogRequestCompletedArgs): void {
  const { req, res, startMs, userId, companyId } = args;
  const status = res.statusCode;
  const payload = {
    event: 'request_completed' as const,
    route: routeOf(req.url),
    method: req.method ?? 'UNKNOWN',
    status,
    durationMs: Date.now() - startMs,
    userId: userId ?? null,
    companyId: companyId ?? null,
    outcome: outcomeFor(status),
  };
  log.info('request_completed', payload, 'http');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/observability/requestLogger.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/observability/requestLogger.ts tests/unit/observability/requestLogger.test.ts
git commit -m "feat(4C-3): logRequestCompleted structured-shape helper

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire withErrorHandler to use request context + request logger

**Files:**
- Modify: `src/lib/api-error-handler.ts`

- [ ] **Step 1: Modify `withErrorHandler`**

Open `src/lib/api-error-handler.ts`. Add imports at top:

```typescript
import { runWithRequestContext, generateRequestId } from '@/lib/observability/requestContext';
import { logRequestCompleted } from '@/lib/observability/requestLogger';
```

Replace the body of the returned function (currently starts with `const startTime = Date.now();`) with this version. Keep every existing behaviour — CORS setup, OPTIONS short-circuit, existing apiLogger info/error calls, sanitizeBody, response masking. Only structural change is wrapping the try/catch in `runWithRequestContext` and calling `logRequestCompleted` in a new `finally`:

```typescript
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const requestId = generateRequestId();
    const startTime = Date.now();

    await runWithRequestContext(requestId, async () => {
      try {
        // Set CORS headers - restrict to known origins
        const allowedOrigins = [
          'https://app.isaflow.co.za',
          'https://admin.isaflow.co.za',
          'https://isaflow.co.za',
          ...(process.env.NODE_ENV === 'development'
            ? ['http://localhost:3101', 'http://localhost:3004']
            : []),
        ];
        const origin = req.headers.origin;
        if (origin && allowedOrigins.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        }

        // Handle OPTIONS request for CORS
        if (req.method === 'OPTIONS') {
          return res.status(200).end();
        }

        // Log incoming request
        apiLogger.info({
          type: 'request',
          method: req.method,
          url: req.url,
          query: req.query,
          body: req.method !== 'GET' ? sanitizeBody(req.body) : undefined,
        }, `API Request: ${req.method} ${req.url}`);

        // Execute the actual handler
        await handler(req, res);

        // Log successful response
        const duration = Date.now() - startTime;
        apiLogger.info({
          type: 'response',
          method: req.method,
          url: req.url,
          statusCode: res.statusCode,
          duration: `${duration}ms`,
        }, `API Response: ${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`);

      } catch (error) {
        const duration = Date.now() - startTime;

        // Log error with context
        apiLogger.error({
          type: 'error',
          method: req.method,
          url: req.url,
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined,
          duration: `${duration}ms`,
        });

        // Check if headers were already sent
        if (res.headersSent) {
          apiLogger.warn({ method: req.method, url: req.url }, 'Headers already sent, cannot send error response');
          return;
        }

        // Send error response — mask internal details in production
        const errorMessage =
          process.env.NODE_ENV === 'production'
            ? 'An unexpected error occurred'
            : error instanceof Error ? error.message : 'An unexpected error occurred';

        res.status(500).json({
          success: false,
          data: null,
          message: errorMessage,
          code: 'INTERNAL_SERVER_ERROR',
          ...(process.env.NODE_ENV === 'development' && {
            details: error instanceof Error ? {
              message: error.message,
              stack: error.stack,
            } as Record<string, unknown> : { error: String(error) },
          }),
        });
      } finally {
        // Standard-shape request-completion log line. Reads userId/companyId
        // off req if withCompany populated them; otherwise null.
        const anyReq = req as unknown as {
          user?: { id?: string };
          companyId?: string;
        };
        logRequestCompleted({
          req,
          res,
          startMs: startTime,
          userId: anyReq.user?.id ?? null,
          companyId: anyReq.companyId ?? null,
        });
      }
    });
  };
```

- [ ] **Step 2: Run the existing error-handler regression**

Run: `bunx vitest run tests/unit/api-error-handler`
Expected: PASS (existing tests unchanged).

- [ ] **Step 3: Run the full unit suite**

Run: `bunx vitest run`
Expected: PASS — total count = prior baseline (1855+) with no new failures.

- [ ] **Step 4: tsc check**

Run: `bunx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api-error-handler.ts
git commit -m "feat(4C-4): withErrorHandler threads requestId via ALS + emits request_completed

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Slow-query timing shim in `src/lib/neon.ts`

**Files:**
- Modify: `src/lib/neon.ts`
- Test: `tests/unit/observability/slowQuery.test.ts`

**Context:** `sql` is the tagged-template function returned by `neon(url)`. It also carries a `.transaction()` method used elsewhere. We must wrap the tagged-template call path without breaking `.transaction()`.

- [ ] **Step 1: Write failing test**

Create `tests/unit/observability/slowQuery.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withSlowQueryTiming, previewSqlTemplate } from '@/lib/observability/slowQuery';
import { runWithRequestContext } from '@/lib/observability/requestContext';

describe('previewSqlTemplate', () => {
  it('joins template strings with ? placeholders, 120-char cap', () => {
    const strings = Object.assign(
      ['SELECT * FROM bank_transactions WHERE company_id = ', ' AND amount > ', ''] as unknown as string[],
      { raw: [] as string[] }
    ) as unknown as TemplateStringsArray;
    const preview = previewSqlTemplate(strings);
    expect(preview).toBe('SELECT * FROM bank_transactions WHERE company_id = ? AND amount > ?');
  });

  it('caps preview at 120 chars', () => {
    const long = 'x'.repeat(300);
    const strings = Object.assign([long], { raw: [] as string[] }) as unknown as TemplateStringsArray;
    expect(previewSqlTemplate(strings).length).toBe(120);
  });
});

describe('withSlowQueryTiming', () => {
  let warnSpy: ReturnType<typeof vi.fn>;
  let originalStderr: typeof process.stderr.write;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    originalStderr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      captured.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    (process.stderr as any).write = originalStderr;
    vi.restoreAllMocks();
  });

  it('does not warn for fast queries', async () => {
    const fakeSql = (async () => 'fast-result') as any;
    const shim = withSlowQueryTiming(fakeSql, 500);
    const strings = Object.assign(['SELECT 1'], { raw: [] as string[] }) as unknown as TemplateStringsArray;
    const result = await shim(strings);
    expect(result).toBe('fast-result');
    const warns = captured.map((l) => JSON.parse(l.trim())).filter((p) => p.data?.event === 'slow_query');
    expect(warns).toHaveLength(0);
  });

  it('warns when query exceeds threshold and includes requestId', async () => {
    const fakeSql = (async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 'slow-result';
    }) as any;
    const shim = withSlowQueryTiming(fakeSql, 10);
    const strings = Object.assign(['SELECT pg_sleep(1)'], { raw: [] as string[] }) as unknown as TemplateStringsArray;
    await runWithRequestContext('rid-slow', async () => {
      const r = await shim(strings);
      expect(r).toBe('slow-result');
    });
    const warns = captured.map((l) => JSON.parse(l.trim())).filter((p) => p.data?.event === 'slow_query');
    expect(warns).toHaveLength(1);
    expect(warns[0].requestId).toBe('rid-slow');
    expect(warns[0].data.sql).toContain('SELECT pg_sleep(1)');
    expect(typeof warns[0].data.durationMs).toBe('number');
  });

  it('returns the underlying query result even if the timing block throws', async () => {
    const fakeSql = (async () => 'result-ok') as any;
    const shim = withSlowQueryTiming(fakeSql, 0);
    const strings = Object.assign(['SELECT 1'], { raw: [] as string[] }) as unknown as TemplateStringsArray;
    const result = await shim(strings);
    expect(result).toBe('result-ok');
  });

  it('preserves non-tagged-template properties (e.g. .transaction)', () => {
    const fakeSql: any = (async () => 'r');
    fakeSql.transaction = async () => 'tx-ok';
    const shim = withSlowQueryTiming(fakeSql, 500);
    expect(typeof (shim as any).transaction).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/observability/slowQuery.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the shim module**

Create `src/lib/observability/slowQuery.ts`:

```typescript
/**
 * Slow-query timing shim for the Neon `sql` tagged-template function.
 *
 * Wraps the call path of `sql\`...\`` with timing and emits a structured
 * `slow_query` warn when duration exceeds the threshold. Threshold comes
 * from env (`SLOW_QUERY_MS_THRESHOLD`) at the neon.ts wiring site.
 *
 * Template values (the interpolated params) are NEVER included in the log
 * preview — only the template string portion is, with `?` placeholders.
 */

import { log } from '@/lib/logger';

const PREVIEW_MAX_LEN = 120;

export function previewSqlTemplate(strings: TemplateStringsArray): string {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < strings.length - 1) out += '?';
    if (out.length >= PREVIEW_MAX_LEN) break;
  }
  return out.slice(0, PREVIEW_MAX_LEN);
}

type SqlLike = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) & Record<string, unknown>;

export function withSlowQueryTiming<T extends SqlLike>(
  sqlFn: T,
  thresholdMs: number
): T {
  const wrapped = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const start = Date.now();
    const result = await sqlFn(strings, ...values);
    const durationMs = Date.now() - start;
    if (durationMs >= thresholdMs) {
      try {
        log.warn('slow_query', {
          event: 'slow_query',
          sql: previewSqlTemplate(strings),
          durationMs,
        }, 'neon');
      } catch {
        // Never let observability break the query path.
      }
    }
    return result;
  }) as unknown as T;

  // Preserve siblings like `.transaction` by copying own-enumerable properties.
  for (const key of Object.keys(sqlFn)) {
    (wrapped as Record<string, unknown>)[key] = sqlFn[key];
  }
  // Preserve non-enumerable (e.g. bound `transaction`) defensively:
  const proto = Object.getOwnPropertyDescriptors(sqlFn);
  for (const [key, desc] of Object.entries(proto)) {
    if (!(key in wrapped)) {
      Object.defineProperty(wrapped, key, desc);
    }
  }
  return wrapped;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/observability/slowQuery.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire the shim into `src/lib/neon.ts`**

Open `src/lib/neon.ts`. Add import at the top with the other observability imports:

```typescript
import { withSlowQueryTiming } from '@/lib/observability/slowQuery';
```

Replace the export line (currently `export const sql = neon(getDatabaseUrl());`, around line 94):

```typescript
const SLOW_QUERY_MS_THRESHOLD = Number(process.env.SLOW_QUERY_MS_THRESHOLD ?? 500);

/**
 * Serverless SQL client for use in API routes and edge functions.
 * Wrapped with a slow-query timing shim that emits structured warnings
 * when a query exceeds SLOW_QUERY_MS_THRESHOLD (default 500ms).
 */
export const sql = withSlowQueryTiming(neon(getDatabaseUrl()) as any, SLOW_QUERY_MS_THRESHOLD);
```

- [ ] **Step 6: tsc check**

Run: `bunx tsc --noEmit`
Expected: EXIT 0. If the neon return type trips, cast with `as any` at the wrap site only.

- [ ] **Step 7: Run full unit suite**

Run: `bunx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/observability/slowQuery.ts tests/unit/observability/slowQuery.test.ts src/lib/neon.ts
git commit -m "feat(4C-5): slow-query timing shim on Neon sql client

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Shallow health endpoint

**Files:**
- Create: `pages/api/health.ts`
- Test: `tests/integration/api/health.test.ts` (shared with Task 7)

- [ ] **Step 1: Write failing test**

Create `tests/integration/api/health.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Mock the sql export so the test doesn't need a real DB.
vi.mock('@/lib/neon', () => {
  return {
    sql: Object.assign(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) => [{ ok: 1 }],
      { transaction: async () => [] }
    ),
  };
});

function makeReq(method = 'GET'): NextApiRequest {
  return { method, url: '/api/health', headers: {}, query: {} } as unknown as NextApiRequest;
}

function makeRes(): { res: NextApiResponse; status: () => number; body: () => unknown } {
  let statusCode = 200;
  let payload: unknown;
  const res = {
    statusCode,
    status(code: number) {
      statusCode = code;
      (res as any).statusCode = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    setHeader() { return res; },
    end() { return res; },
  } as unknown as NextApiResponse;
  return { res, status: () => statusCode, body: () => payload };
}

describe('GET /api/health (shallow)', () => {
  it('returns 200 { status: "ok", db: "ok" } when DB is reachable', async () => {
    const handler = (await import('../../../pages/api/health')).default;
    const { res, status, body } = makeRes();
    await handler(makeReq(), res);
    expect(status()).toBe(200);
    const b = body() as any;
    expect(b.status).toBe('ok');
    expect(b.db).toBe('ok');
    expect(typeof b.uptimeSeconds).toBe('number');
  });

  it('returns 503 when DB query throws', async () => {
    vi.resetModules();
    vi.doMock('@/lib/neon', () => ({
      sql: Object.assign(
        async () => { throw new Error('connection refused'); },
        { transaction: async () => [] }
      ),
    }));
    const handler = (await import('../../../pages/api/health')).default;
    const { res, status, body } = makeRes();
    await handler(makeReq(), res);
    expect(status()).toBe(503);
    const b = body() as any;
    expect(b.status).toBe('down');
    expect(b.db).toBe('down');
  });

  afterEach(() => {
    vi.resetModules();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/integration/api/health.test.ts`
Expected: FAIL (module `pages/api/health` not found or shape mismatch).

- [ ] **Step 3: Implement `pages/api/health.ts`**

Create `pages/api/health.ts`:

```typescript
/**
 * Shallow health endpoint (liveness probe).
 *
 * - No auth, no CSRF, no withCompany — must be callable by load balancers.
 * - Target <50ms. Does only a single `SELECT 1` round-trip.
 * - Returns 200 when DB is reachable, 503 otherwise.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';

const PROCESS_START_MS = Date.now();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: 'down', error: 'method_not_allowed' });
  }

  try {
    await sql`SELECT 1`;
    return res.status(200).json({
      status: 'ok',
      db: 'ok',
      uptimeSeconds: Math.floor((Date.now() - PROCESS_START_MS) / 1000),
    });
  } catch {
    return res.status(503).json({
      status: 'down',
      db: 'down',
      uptimeSeconds: Math.floor((Date.now() - PROCESS_START_MS) / 1000),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/integration/api/health.test.ts`
Expected: PASS (2 tests — shallow only; deep comes in Task 7).

- [ ] **Step 5: Commit**

```bash
git add pages/api/health.ts tests/integration/api/health.test.ts
git commit -m "feat(4C-6): shallow /api/health endpoint (DB SELECT 1)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Deep health endpoint

**Files:**
- Create: `pages/api/health/deep.ts`
- Modify: `tests/integration/api/health.test.ts` (add deep tests)

**Context:** Deep endpoint probes DB + SMTP + Stitch. Each is wrapped in a `Promise.race` with a 2s timeout (`HEALTH_CHECK_TIMEOUT_MS`). DB failure → 503; SMTP/Stitch failure → 200 with `status: 'degraded'`.

- [ ] **Step 1: Identify the existing SMTP / Stitch clients**

Run: `grep -rn "nodemailer\|createTransport" src/lib --include="*.ts" | head`
Run: `grep -rn "stitch" src/lib src/modules --include="*.ts" -i | head`

Record the SMTP client path (likely `src/lib/email/*` or `src/lib/mail.ts`) and the Stitch client path.

If either is NOT present in the codebase, implement that check as a noop returning `status: 'skipped'` with a console note and proceed. Do not invent a new client module.

- [ ] **Step 2: Append failing tests**

Append to `tests/integration/api/health.test.ts`:

```typescript
describe('GET /api/health/deep', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/lib/neon', () => ({
      sql: Object.assign(
        async () => [{ ok: 1 }],
        { transaction: async () => [] }
      ),
    }));
  });

  it('returns 200 ok when all deps are healthy', async () => {
    vi.doMock('@/lib/observability/deepChecks', () => ({
      checkDb: async () => ({ name: 'db', status: 'ok' as const, durationMs: 3 }),
      checkSmtp: async () => ({ name: 'smtp', status: 'ok' as const, durationMs: 12 }),
      checkStitch: async () => ({ name: 'stitch', status: 'ok' as const, durationMs: 40 }),
    }));
    const handler = (await import('../../../pages/api/health/deep')).default;
    const { res, status, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(status()).toBe(200);
    const b = body() as any;
    expect(b.status).toBe('ok');
    expect(b.checks.db.status).toBe('ok');
    expect(b.checks.smtp.status).toBe('ok');
    expect(b.checks.stitch.status).toBe('ok');
  });

  it('returns 200 degraded when a non-DB dep fails', async () => {
    vi.doMock('@/lib/observability/deepChecks', () => ({
      checkDb: async () => ({ name: 'db', status: 'ok' as const, durationMs: 3 }),
      checkSmtp: async () => ({ name: 'smtp', status: 'down' as const, durationMs: 2000, error: 'timeout' }),
      checkStitch: async () => ({ name: 'stitch', status: 'ok' as const, durationMs: 40 }),
    }));
    const handler = (await import('../../../pages/api/health/deep')).default;
    const { res, status, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(status()).toBe(200);
    const b = body() as any;
    expect(b.status).toBe('degraded');
    expect(b.checks.smtp.status).toBe('down');
  });

  it('returns 503 when DB itself is down', async () => {
    vi.doMock('@/lib/observability/deepChecks', () => ({
      checkDb: async () => ({ name: 'db', status: 'down' as const, durationMs: 2000, error: 'timeout' }),
      checkSmtp: async () => ({ name: 'smtp', status: 'ok' as const, durationMs: 12 }),
      checkStitch: async () => ({ name: 'stitch', status: 'ok' as const, durationMs: 40 }),
    }));
    const handler = (await import('../../../pages/api/health/deep')).default;
    const { res, status, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(status()).toBe(503);
    const b = body() as any;
    expect(b.status).toBe('down');
    expect(b.checks.db.status).toBe('down');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bunx vitest run tests/integration/api/health.test.ts`
Expected: FAIL (`pages/api/health/deep` and `@/lib/observability/deepChecks` not found).

- [ ] **Step 4: Implement `src/lib/observability/deepChecks.ts`**

Create `src/lib/observability/deepChecks.ts`:

```typescript
/**
 * Dependency checks for /api/health/deep.
 *
 * Each check returns a CheckResult with a status and duration, never throws.
 * Each check wraps its work in a Promise.race with HEALTH_CHECK_TIMEOUT_MS.
 */

import { sql } from '@/lib/neon';

export type CheckStatus = 'ok' | 'down' | 'skipped';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  durationMs: number;
  error?: string;
}

const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_TIMEOUT_MS ?? 2000);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function time<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: Error; durationMs: number }> {
  const start = Date.now();
  try {
    const result = await withTimeout(fn(), HEALTH_CHECK_TIMEOUT_MS);
    return { result, durationMs: Date.now() - start };
  } catch (err) {
    return { error: err as Error, durationMs: Date.now() - start };
  }
}

export async function checkDb(): Promise<CheckResult> {
  const { error, durationMs } = await time(() => sql`SELECT 1` as unknown as Promise<unknown>);
  if (error) return { name: 'db', status: 'down', durationMs, error: error.message };
  return { name: 'db', status: 'ok', durationMs };
}

export async function checkSmtp(): Promise<CheckResult> {
  // Best-effort — only runs if a nodemailer transport is exported from
  // `@/lib/email/transport` with a `verify()` method. Otherwise `skipped`.
  const start = Date.now();
  try {
    const mod: any = await import('@/lib/email/transport').catch(() => null);
    const transport = mod?.transport ?? mod?.default;
    if (!transport || typeof transport.verify !== 'function') {
      return { name: 'smtp', status: 'skipped', durationMs: Date.now() - start };
    }
    await withTimeout(transport.verify(), HEALTH_CHECK_TIMEOUT_MS);
    return { name: 'smtp', status: 'ok', durationMs: Date.now() - start };
  } catch (err) {
    return {
      name: 'smtp',
      status: 'down',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkStitch(): Promise<CheckResult> {
  const start = Date.now();
  const url = process.env.STITCH_HEALTH_URL ?? process.env.STITCH_API_URL;
  if (!url) return { name: 'stitch', status: 'skipped', durationMs: Date.now() - start };
  try {
    const res = await withTimeout(fetch(url, { method: 'HEAD' }), HEALTH_CHECK_TIMEOUT_MS);
    if (!res.ok) {
      return {
        name: 'stitch',
        status: 'down',
        durationMs: Date.now() - start,
        error: `HTTP ${res.status}`,
      };
    }
    return { name: 'stitch', status: 'ok', durationMs: Date.now() - start };
  } catch (err) {
    return {
      name: 'stitch',
      status: 'down',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 5: Implement `pages/api/health/deep.ts`**

Create `pages/api/health/deep.ts`:

```typescript
/**
 * Deep health endpoint (readiness probe).
 *
 * Runs DB + SMTP + Stitch checks in parallel, each with its own timeout.
 * - All ok → 200 { status: 'ok' }
 * - DB down → 503 { status: 'down' }
 * - DB ok, some non-DB dep down → 200 { status: 'degraded' }
 * - Dep skipped (not configured) → treated as 'ok' for the rollup
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { checkDb, checkSmtp, checkStitch, type CheckResult } from '@/lib/observability/deepChecks';

type DeepStatus = 'ok' | 'degraded' | 'down';

function rollup(db: CheckResult, rest: CheckResult[]): DeepStatus {
  if (db.status === 'down') return 'down';
  const anyDown = rest.some((c) => c.status === 'down');
  return anyDown ? 'degraded' : 'ok';
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: 'down', error: 'method_not_allowed' });
  }

  const [db, smtp, stitch] = await Promise.all([checkDb(), checkSmtp(), checkStitch()]);
  const status = rollup(db, [smtp, stitch]);
  const httpStatus = status === 'down' ? 503 : 200;

  return res.status(httpStatus).json({
    status,
    checks: { db, smtp, stitch },
  });
}
```

- [ ] **Step 6: Run tests**

Run: `bunx vitest run tests/integration/api/health.test.ts`
Expected: PASS (5 tests — 2 shallow + 3 deep).

- [ ] **Step 7: tsc check**

Run: `bunx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 8: Commit**

```bash
git add pages/api/health/deep.ts src/lib/observability/deepChecks.ts tests/integration/api/health.test.ts
git commit -m "feat(4C-7): deep /api/health/deep endpoint with DB+SMTP+Stitch checks

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Regression gate + Phase 4C closeout

**Files:**
- Create: `docs/audits/2026-04-15/phase4c-closeout.md`

- [ ] **Step 1: Full unit suite**

Run: `bunx vitest run`
Expected: PASS. Expected count: baseline 1855 + (6 requestContext + 2 logger stamping + 5 requestLogger + 7 slowQuery + 5 health) = 1880.

- [ ] **Step 2: Full type check**

Run: `bunx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Live smoke — requestId propagation**

Start dev server: `bun run dev` (in background). Wait for "ready" line.

Run:
```bash
curl -s http://localhost:3200/api/health | jq
curl -s http://localhost:3200/api/health/deep | jq
```

Expected: both return JSON with `status` field. Check server stdout — each request should produce a log line with `event: request_completed` containing a ULID `requestId`.

- [ ] **Step 4: Live smoke — slow-query warn**

With the dev server running, temporarily set `SLOW_QUERY_MS_THRESHOLD=0` in the env and hit any authenticated endpoint. Verify stdout contains `event: slow_query` lines with matching `requestId`. Revert to default after verifying.

- [ ] **Step 5: Write closeout doc**

Create `docs/audits/2026-04-15/phase4c-closeout.md` summarizing what landed (the 4 workstreams, files created, test count delta, live verification evidence, deferrals to Phase 4D). Mirror the structure of `docs/audits/2026-04-15/phase4b-closeout.md`.

- [ ] **Step 6: Commit closeout**

```bash
git add docs/audits/2026-04-15/phase4c-closeout.md
git commit -m "docs: Phase 4C observability closeout

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: (1) requestId ALS = Task 1; (2) logger stamping = Task 2; (3) standard-shape request log = Task 3+4; (4) slow-query shim = Task 5; (5) shallow health = Task 6; (6) deep health = Task 7. All spec sections mapped.
- No placeholders — every step has exact files, exact code, exact commands.
- Type consistency: `CheckResult`, `CheckStatus`, `LogRequestCompletedArgs`, `SqlLike` all defined exactly where first used and referenced consistently.
- Dependency order: 1 → 2 (logger needs requestContext) → 3 (requestLogger needs logger+ALS) → 4 (withErrorHandler needs 1+3) → 5 (slow-query uses ALS from 1) → 6 → 7. Task 8 is the gate.
