import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  getStaffUtilisation,
  getClientProfitability,
  getWipAging,
  getRevenuePipeline,
  getComplianceReport,
  getServiceMix,
} from '@/modules/accounting/services/practice/practiceReportsService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_1 = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT_1 = 'cccccccc-0000-0000-0000-000000000003';
const CAT_1 = 'dddddddd-0000-0000-0000-000000000004';

beforeEach(() => vi.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// getStaffUtilisation
// ─────────────────────────────────────────────────────────────────────────────
describe('getStaffUtilisation', () => {
  it('returns mapped rows with utilisationPct', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        user_id: USER_1,
        total_hours: '8',
        billable_hours: '6',
        billable_value: '5100',
      },
    ]);

    const result = await getStaffUtilisation(COMPANY, {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    });

    expect(result).toHaveLength(1);
    const row = result[0]!;
    expect(row.userId).toBe(USER_1);
    expect(row.totalHours).toBe(8);
    expect(row.billableHours).toBe(6);
    expect(row.nonBillableHours).toBe(2);
    expect(row.billableValue).toBe(5100);
    expect(row.utilisationPct).toBe(75);
  });

  it('returns 0 utilisationPct when totalHours is 0 (no divide-by-zero)', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        user_id: USER_1,
        total_hours: '0',
        billable_hours: '0',
        billable_value: '0',
      },
    ]);

    const result = await getStaffUtilisation(COMPANY, {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    });

    expect(result[0]!.utilisationPct).toBe(0);
    expect(result[0]!.nonBillableHours).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getClientProfitability
// ─────────────────────────────────────────────────────────────────────────────
describe('getClientProfitability', () => {
  it('returns mapped rows with timeCost, margin, marginPct computed', async () => {
    // Query A: revenue rows
    sqlMock.mockResolvedValueOnce([
      {
        practice_client_id: CLIENT_1,
        legal_name: 'Acme Ltd',
        revenue: '12000',
        hours: '14',
      },
    ]);
    // Query B: time cost rows
    sqlMock.mockResolvedValueOnce([
      {
        practice_client_id: CLIENT_1,
        time_cost: '8400',
      },
    ]);

    const result = await getClientProfitability(COMPANY, {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    });

    expect(result).toHaveLength(1);
    const row = result[0]!;
    expect(row.practiceClientId).toBe(CLIENT_1);
    expect(row.legalName).toBe('Acme Ltd');
    expect(row.revenue).toBe(12000);
    expect(row.hours).toBe(14);
    expect(row.timeCost).toBe(8400);
    expect(row.margin).toBe(3600);
    expect(row.marginPct).toBe(30);
  });

  it('sets marginPct to 0 when revenue is 0 (no divide-by-zero)', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        practice_client_id: CLIENT_1,
        legal_name: 'Zero Rev',
        revenue: '0',
        hours: '5',
      },
    ]);
    sqlMock.mockResolvedValueOnce([
      { practice_client_id: CLIENT_1, time_cost: '500' },
    ]);

    const result = await getClientProfitability(COMPANY, {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    });

    const row = result[0]!;
    expect(row.marginPct).toBe(0);
    expect(row.margin).toBe(-500);
  });

  it('uses timeCost=0 when client has no cost rate entries', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        practice_client_id: CLIENT_1,
        legal_name: 'Acme Ltd',
        revenue: '5000',
        hours: '8',
      },
    ]);
    // Cost query returns empty — client not in map
    sqlMock.mockResolvedValueOnce([]);

    const result = await getClientProfitability(COMPANY, {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    });

    const row = result[0]!;
    expect(row.timeCost).toBe(0);
    expect(row.margin).toBe(5000);
    expect(row.marginPct).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getWipAging
// ─────────────────────────────────────────────────────────────────────────────
describe('getWipAging', () => {
  it('returns buckets correctly', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        practice_client_id: CLIENT_1,
        legal_name: 'Acme Ltd',
        total: '9500',
        bucket_0_7: '3000',
        bucket_8_14: '2500',
        bucket_15_30: '2000',
        bucket_31_plus: '2000',
      },
    ]);

    const result = await getWipAging(COMPANY, { asOfDate: '2026-04-19' });

    expect(result).toHaveLength(1);
    const row = result[0]!;
    expect(row.practiceClientId).toBe(CLIENT_1);
    expect(row.legalName).toBe('Acme Ltd');
    expect(row.total).toBe(9500);
    expect(row.bucket0to7).toBe(3000);
    expect(row.bucket8to14).toBe(2500);
    expect(row.bucket15to30).toBe(2000);
    expect(row.bucket31plus).toBe(2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRevenuePipeline
// ─────────────────────────────────────────────────────────────────────────────
describe('getRevenuePipeline', () => {
  it('returns scalar summary with forecast = totalApproved * 0.8', async () => {
    sqlMock.mockResolvedValueOnce([{ v: '10000' }]); // totalApproved
    sqlMock.mockResolvedValueOnce([{ v: '4000' }]);  // totalInvoicedLast30d

    const result = await getRevenuePipeline(COMPANY, { asOfDate: '2026-04-19' });

    expect(result.totalApproved).toBe(10000);
    expect(result.totalInvoicedLast30d).toBe(4000);
    expect(result.forecast30d).toBe(8000);
    expect(result.asOfDate).toBe('2026-04-19');
  });

  it('uses today as default asOfDate when not provided', async () => {
    sqlMock.mockResolvedValueOnce([{ v: '0' }]);
    sqlMock.mockResolvedValueOnce([{ v: '0' }]);

    const result = await getRevenuePipeline(COMPANY, {});

    // asOfDate should be a valid YYYY-MM-DD
    expect(result.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getComplianceReport
// ─────────────────────────────────────────────────────────────────────────────
describe('getComplianceReport', () => {
  // Period: Mon 2026-04-13 to Fri 2026-04-17 → 5 weekdays
  const INPUT = { periodStart: '2026-04-13', periodEnd: '2026-04-17' };
  const ALL_DAYS = ['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17'];

  it('classifies user as compliant when all weekdays submitted', async () => {
    sqlMock.mockResolvedValueOnce([{ user_id: USER_1 }]); // distinct users
    sqlMock.mockResolvedValueOnce(
      ALL_DAYS.map(d => ({ d })),                         // submitted days
    );

    const result = await getComplianceReport(COMPANY, INPUT);

    expect(result).toHaveLength(1);
    const row = result[0]!;
    expect(row.userId).toBe(USER_1);
    expect(row.expectedDays).toBe(5);
    expect(row.submittedDays).toBe(5);
    expect(row.missingDays).toHaveLength(0);
    expect(row.status).toBe('compliant');
  });

  it('classifies user as missing when no submissions', async () => {
    sqlMock.mockResolvedValueOnce([{ user_id: USER_1 }]); // distinct users
    sqlMock.mockResolvedValueOnce([]);                     // no submitted days

    const result = await getComplianceReport(COMPANY, INPUT);

    const row = result[0]!;
    expect(row.submittedDays).toBe(0);
    expect(row.missingDays).toHaveLength(5);
    expect(row.status).toBe('missing');
  });

  it('classifies user as partial when some weekdays missing', async () => {
    sqlMock.mockResolvedValueOnce([{ user_id: USER_1 }]);
    sqlMock.mockResolvedValueOnce([
      { d: '2026-04-13' },
      { d: '2026-04-14' },
    ]);

    const result = await getComplianceReport(COMPANY, INPUT);

    const row = result[0]!;
    expect(row.submittedDays).toBe(2);
    expect(row.missingDays).toEqual(['2026-04-15', '2026-04-16', '2026-04-17']);
    expect(row.status).toBe('partial');
  });

  it('returns empty array when no users found', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const result = await getComplianceReport(COMPANY, INPUT);

    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getServiceMix
// ─────────────────────────────────────────────────────────────────────────────
describe('getServiceMix', () => {
  it('returns mapped rows with pct normalised to 100', async () => {
    sqlMock.mockResolvedValueOnce([
      { job_category_id: CAT_1, name: 'Audit', hours: '10', value: '6000' },
      { job_category_id: 'cat-2', name: 'Tax', hours: '4', value: '4000' },
    ]);

    const result = await getServiceMix(COMPANY, {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    });

    expect(result).toHaveLength(2);
    expect(result[0]!.pct).toBe(60);
    expect(result[1]!.pct).toBe(40);
    expect(result[0]!.pct + result[1]!.pct).toBe(100);
  });

  it('pct rounds to 2 decimal places', async () => {
    sqlMock.mockResolvedValueOnce([
      { job_category_id: CAT_1, name: 'Cat A', hours: '1', value: '1' },
      { job_category_id: 'cat-2', name: 'Cat B', hours: '1', value: '2' },
    ]);

    const result = await getServiceMix(COMPANY, {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    });

    // 1/3 * 100 = 33.33...
    expect(result[0]!.pct).toBe(33.33);
    // 2/3 * 100 = 66.67
    expect(result[1]!.pct).toBe(66.67);
  });

  it('returns 0 pct for all rows when totalValue is 0', async () => {
    sqlMock.mockResolvedValueOnce([
      { job_category_id: CAT_1, name: 'Cat A', hours: '5', value: '0' },
    ]);

    const result = await getServiceMix(COMPANY, {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    });

    expect(result[0]!.pct).toBe(0);
  });
});
