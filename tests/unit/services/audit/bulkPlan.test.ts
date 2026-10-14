/**
 * bulkPlan restores the planner setting after a successful read, and on a failed one lets the ORIGINAL error out —
 * a restore on an aborted transaction would throw 25P02 over it, and a failed automatic snapshot would then record
 * "current transaction is aborted" instead of why it failed.
 */
import { describe, expect, it, vi } from 'vitest';

const statements: string[] = [];
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    statements.push(`${text} ${values.join(',')}`.trim());
    if (text.includes('current_setting')) return Promise.resolve([{ v: 'on' }]);
    return Promise.resolve([]);
  },
}));

import { bulkPlan } from '@/modules/accounting/services/audit/snapshotRows';

describe('bulkPlan', () => {
  it('turns nested loops off for the read and restores the previous value', async () => {
    statements.length = 0;
    expect(await bulkPlan(async () => 42)).toBe(42);
    expect(statements.filter((t) => t.includes('set_config'))).toEqual([
      "SELECT set_config('enable_nestloop', 'off', true)", "SELECT set_config('enable_nestloop', ?, true) on"]);
  });

  it('a failed read surfaces its own error and attempts no restore', async () => {
    statements.length = 0;
    const cause = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    await expect(bulkPlan(async () => { throw cause; })).rejects.toBe(cause);
    expect(statements.filter((t) => t.includes('set_config'))).toHaveLength(1);
  });
});
