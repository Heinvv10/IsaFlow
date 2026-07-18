/**
 * Shared mock-DB harness for the PRD-10 auth test suite (MCP Phase 0).
 *
 * `vi.mock` is hoisted per test file, so each consumer must declare the
 * '@/lib/neon' mock itself (same factory shape as the service tests):
 *
 *   vi.mock('@/lib/neon', () => {
 *     const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
 *     return {
 *       sql: sqlFn,
 *       withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
 *     };
 *   });
 *
 * These helpers then operate on that shared mocked `sql` tagged template.
 */
import { vi } from 'vitest';
import { sql } from '@/lib/neon';

type SqlMock = ReturnType<typeof vi.fn>;

export const sqlMock = sql as unknown as SqlMock;

/** Reset call history and restore the default empty-rowset response. */
export function resetSqlMock(): void {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
}

/** Queue `rows` as the resolved value for the NEXT sql`` call only. */
export function mockSqlOnce(rows: unknown[]): void {
  sqlMock.mockResolvedValueOnce(rows);
}

/** The literal SQL text of call N (template strings joined on placeholders). */
export function sqlCallText(callIndex: number): string {
  const call = sqlMock.mock.calls[callIndex];
  if (!call) throw new Error(`no sql call at index ${callIndex}`);
  return (call[0] as ReadonlyArray<string>).join(' ? ');
}

/** Interpolated values (not the template-strings array) of call N. */
export function sqlCallValues(callIndex: number): unknown[] {
  const call = sqlMock.mock.calls[callIndex];
  if (!call) throw new Error(`no sql call at index ${callIndex}`);
  return call.slice(1);
}

/** Every interpolated value across all sql`` calls so far. */
export function allSqlValues(): unknown[] {
  return sqlMock.mock.calls.flatMap((call) => call.slice(1));
}
