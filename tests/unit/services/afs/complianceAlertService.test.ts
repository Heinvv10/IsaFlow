// tests/unit/services/afs/complianceAlertService.test.ts
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  createAfsAlert,
  getActiveAfsAlerts,
  dismissAfsAlert,
} from '@/modules/accounting/services/afs/complianceAlertService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ALERT_ID = '99999999-8888-7777-6666-555555555555';
const USER_ID  = 'cccccccc-dddd-eeee-ffff-000000000001';

describe('complianceAlertService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('createAfsAlert', () => {
    it('calls INSERT ... ON CONFLICT DO NOTHING (idempotent)', async () => {
      mockSql.mockResolvedValueOnce([]);

      await createAfsAlert(
        COMPANY,
        'pis_threshold_100',
        'PIS has crossed 100',
        'warning',
        'Previous: 90, Current: 105'
      );

      expect(mockSql).toHaveBeenCalledTimes(1);
      // Verify the ON CONFLICT pattern is used (the sql tag is called with the INSERT)
      const callArgs = mockSql.mock.calls[0];
      // callArgs[0] is the TemplateStringsArray — check the combined SQL string
      const sqlParts = (callArgs?.[0] as string[]).join('');
      expect(sqlParts.toLowerCase()).toContain('on conflict');
      expect(sqlParts.toLowerCase()).toContain('do nothing');
    });

    it('does not throw when called twice for the same alert type (idempotent)', async () => {
      mockSql.mockResolvedValue([]);

      await createAfsAlert(COMPANY, 'pis_threshold_100', 'msg', 'warning');
      await createAfsAlert(COMPANY, 'pis_threshold_100', 'msg', 'warning');

      // Both calls succeed; uniqueness enforced by DB partial index
      expect(mockSql).toHaveBeenCalledTimes(2);
    });
  });

  describe('getActiveAfsAlerts', () => {
    it('returns mapped alert objects with ISO timestamps', async () => {
      const firedDate = new Date('2026-04-16T10:00:00Z');
      mockSql.mockResolvedValueOnce([
        {
          id: ALERT_ID,
          company_id: COMPANY,
          alert_type: 'afs_filing_deadline_30',
          message: 'Filing deadline approaching',
          detail: 'Deadline: 2026-08-28',
          fired_at: firedDate,
          dismissed_at: null,
          dismissed_by: null,
        },
      ]);

      const alerts = await getActiveAfsAlerts(COMPANY);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.id).toBe(ALERT_ID);
      expect(alerts[0]?.alertType).toBe('afs_filing_deadline_30');
      expect(alerts[0]?.message).toBe('Filing deadline approaching');
      expect(alerts[0]?.detail).toBe('Deadline: 2026-08-28');
      expect(alerts[0]?.firedAt).toBe('2026-04-16T10:00:00.000Z');
      expect(alerts[0]?.dismissedAt).toBeNull();
    });

    it('filters out dismissed alerts via SQL WHERE dismissed_at IS NULL', async () => {
      // Return only undismissed rows (DB query already filters)
      mockSql.mockResolvedValueOnce([]);

      const alerts = await getActiveAfsAlerts(COMPANY);

      expect(alerts).toHaveLength(0);
      const sqlParts = (mockSql.mock.calls[0]?.[0] as string[]).join('');
      expect(sqlParts.toLowerCase()).toContain('dismissed_at is null');
    });

    it('handles string fired_at (non-Date) gracefully', async () => {
      mockSql.mockResolvedValueOnce([
        {
          id: ALERT_ID,
          company_id: COMPANY,
          alert_type: 'pis_threshold_350',
          message: 'PIS crossed 350',
          detail: null,
          fired_at: '2026-04-10T08:00:00Z',
          dismissed_at: null,
          dismissed_by: null,
        },
      ]);

      const alerts = await getActiveAfsAlerts(COMPANY);
      expect(alerts[0]?.firedAt).toBe('2026-04-10T08:00:00Z');
      expect(alerts[0]?.detail).toBeUndefined();
    });
  });

  describe('dismissAfsAlert', () => {
    it('calls UPDATE with dismissed_at = now() and dismissed_by', async () => {
      mockSql.mockResolvedValueOnce([]);

      await dismissAfsAlert(COMPANY, ALERT_ID, USER_ID);

      expect(mockSql).toHaveBeenCalledTimes(1);
      const sqlParts = (mockSql.mock.calls[0]?.[0] as string[]).join('');
      expect(sqlParts.toLowerCase()).toContain('dismissed_at');
      expect(sqlParts.toLowerCase()).toContain('dismissed_by');
    });

    it('includes company_id in WHERE clause (tenant scoping)', async () => {
      mockSql.mockResolvedValueOnce([]);

      await dismissAfsAlert(COMPANY, ALERT_ID, USER_ID);

      const sqlParts = (mockSql.mock.calls[0]?.[0] as string[]).join('');
      expect(sqlParts.toLowerCase()).toContain('company_id');
    });
  });
});
