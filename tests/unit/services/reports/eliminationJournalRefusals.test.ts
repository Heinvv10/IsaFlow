/**
 * D4 round 8 (blind review LOW-4): the elimination journal throws TYPED refusals — unbalanced
 * lines before any SQL, and post / reverse that update no row — so the route can answer 400 / 409.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  createEliminationAdjustment, postEliminationAdjustment, reverseEliminationAdjustment,
} from '@/modules/accounting/services/reports/consolidatedReportingService';
import { EliminationStateError, EliminationUnbalancedError } from '@/modules/accounting/services/reports/eliminationErrors';

const G = '80000000-0000-4000-8000-000000000001';
const ADJ = '70000000-0000-4000-8000-000000000001';
const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { mockSql.mockReset(); });

describe('elimination journal refusals', () => {
  it('unbalanced lines → EliminationUnbalancedError, before any SQL', async () => {
    const err = await createEliminationAdjustment(G, {
      adjustmentType: 'interco_revenue', description: 'x', periodStart: '2026-01-31', periodEnd: '2026-01-31',
      lines: [{ groupAccountId: 'a', debit: 10, credit: 0, description: '' }, { groupAccountId: 'b', debit: 0, credit: 9, description: '' }],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EliminationUnbalancedError);
    expect(err).toMatchObject({ totalDebit: 10, totalCredit: 9 });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it.each([
    ['post', postEliminationAdjustment, 'draft'],
    ['reverse', reverseEliminationAdjustment, 'posted'],
  ] as const)('%s that updates no row → EliminationStateError (%s required)', async (_n, fn, requiredStatus) => {
    mockSql.mockResolvedValueOnce([]);
    const err = await fn(ADJ, G).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EliminationStateError);
    expect(err).toMatchObject({ adjustmentId: ADJ, requiredStatus });
  });
});
