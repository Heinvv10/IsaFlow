/**
 * driverChangesSince (MCP budget tools PR 3, review L7): counts the version's audit rows of entity 'budget' that
 * carry `driverAction` at or AFTER the given time (>=: a driver write in the amount write's own transaction has the
 * same created_at), for the company only; answers the count the database returned.
 */
import { describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => [{ n: 3 }]));
vi.mock('@/lib/neon', () => ({ sql }));

import { driverChangesSince } from '@/modules/accounting/services/budgets/budgetVersionActivity';

describe('driverChangesSince', () => {
  it('one company-scoped count of driver audit rows at or after the time', async () => {
    expect(await driverChangesSince('co', 'v', '2026-11-16T10:00:00.000001Z')).toBe(3);
    const [strings, ...values] = sql.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    const text = strings.join('?').replace(/\s+/g, ' ');
    expect(text).toMatch(/FROM audit_log WHERE company_id = \?::UUID AND entity_type = 'budget' AND entity_id = \?::UUID/);
    expect(text).toMatch(/\(changes -> 'metadata' ->> 'driverAction'\) IS NOT NULL AND created_at >= \?::TIMESTAMPTZ/);
    expect(values).toEqual(['co', 'v', '2026-11-16T10:00:00.000001Z']);
  });

  it('no row reads as none', async () => {
    sql.mockResolvedValueOnce([]);
    expect(await driverChangesSince('co', 'v', 't')).toBe(0);
  });
});
