/**
 * A dry run executes the real write and rolls it back (core/rolledBackSavepoint), so its log lines ("Reversed
 * journal entry", "Cancelled credit note") describe nothing that happened. The logger tags every line emitted inside
 * one `dryRun: true` with a message prefix, across awaits, and leaves lines outside it untouched.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';

let lines: string[];
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  lines = [];
  spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as never);
  als.enterWith({ client: { query: vi.fn(async () => ({ rows: [] })) }, userId: 'u1', claims: {} } as unknown as Parameters<typeof als.enterWith>[0]);
});
afterEach(() => spy.mockRestore());

const parsed = (needle: string) => JSON.parse(lines.find((l) => l.includes(needle))!) as { message: string; dryRun?: boolean };

describe('dry-run log lines', () => {
  it('lines emitted inside a rolled-back savepoint say so, even after an await', async () => {
    await inRolledBackSavepoint('sp_log', async () => {
      log.info('Cancelled credit note A', {}, 'accounting');
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      log.info('Reversed journal entry B', {}, 'accounting');
    });
    expect(parsed('Cancelled credit note A')).toMatchObject({ message: '[dry run, rolled back] Cancelled credit note A', dryRun: true });
    expect(parsed('Reversed journal entry B')).toMatchObject({ message: '[dry run, rolled back] Reversed journal entry B', dryRun: true });
  });

  it('lines emitted outside one are unchanged and carry no dryRun key', async () => {
    await inRolledBackSavepoint('sp_log', async () => { log.info('inside', {}, 'accounting'); });
    log.info('Cancelled credit note live', {}, 'accounting');
    const live = parsed('Cancelled credit note live');
    expect(live.message).toBe('Cancelled credit note live');
    expect(live).not.toHaveProperty('dryRun');
  });
});
