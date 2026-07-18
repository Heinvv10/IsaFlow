/**
 * PAT scope UI metadata drift guard — MCP Phase 2, Task 2.5.
 * The PAT-mint page builds its scope checklist from PAT_SCOPE_META; this
 * test (plus the Record<PatScope, …> type) guarantees a new scope can never
 * ship without UI metadata, and stale metadata can never outlive a scope.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { PAT_SCOPES } from '@/lib/auth/personalAccessTokens';
import { PAT_SCOPE_META } from '@/lib/auth/patScopeMeta';

describe('PAT_SCOPE_META', () => {
  it('covers exactly the PAT_SCOPES vocabulary (no drift either way)', () => {
    expect(Object.keys(PAT_SCOPE_META).sort()).toEqual([...PAT_SCOPES].sort());
  });

  it('every entry has a human label and description', () => {
    for (const scope of PAT_SCOPES) {
      expect(PAT_SCOPE_META[scope].label.length).toBeGreaterThan(3);
      expect(PAT_SCOPE_META[scope].desc.length).toBeGreaterThan(10);
    }
  });
});
