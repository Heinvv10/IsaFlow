// RED phase — written before implementation
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  listLoans,
  getLoanById,
  createLoan,
  updateLoan,
  addLoanEvent,
  getLoanEvents,
} from '@/modules/accounting/services/loans/loanService';
import type { LoanCreateInput } from '@/modules/accounting/services/loans/loanService';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOAN_ID    = 'bbbbbbbb-0000-0000-0000-000000000002';
const CURVE_ID   = 'cccccccc-0000-0000-0000-000000000003';
const USER_ID    = 'dddddddd-0000-0000-0000-000000000004';

function makeLoanRow(overrides = {}) {
  return {
    id: LOAN_ID,
    company_id: COMPANY_ID,
    curve_id: CURVE_ID,
    counterparty_id: null,
    gl_account_id: null,
    reference: 'BND-001',
    product: 'bond',
    description: 'Test bond',
    principal: '224873.49',
    start_date: '2026-03-15',
    term_months: 72,
    rate_mode: 'PRIME_PLUS',
    margin: '4.0000',
    fixed_rate: null,
    residual: '0.00',
    day_count: 'ACTUAL_365',
    reprice_mode: 'RESOLVE_ON_RATE_CHANGE',
    skip_mode: 'MAINTAIN_TERM',
    lump_mode: 'REDUCE_INSTALLMENT',
    recurring_skip_months: [12, 1],
    status: 'active',
    nca_compliant: true,
    currency: 'ZAR',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeEventRow(overrides = {}) {
  return {
    id: 'eeeeeeee-0000-0000-0000-000000000005',
    loan_id: LOAN_ID,
    company_id: COMPANY_ID,
    event_date: '2026-05-15',
    kind: 'SKIP',
    amount: null,
    note: null,
    posted_by: USER_ID,
    posted_at: '2026-04-19T00:00:00Z',
    ...overrides,
  };
}

const VALID_CREATE: LoanCreateInput = {
  curveId: CURVE_ID,
  reference: 'BND-001',
  product: 'bond',
  principal: 224_873.49,
  startDate: '2026-03-15',
  termMonths: 72,
  rateMode: 'PRIME_PLUS',
  margin: 4,
  residual: 0,
  recurringSkipMonths: [12, 1],
  repriceMode: 'RESOLVE_ON_RATE_CHANGE',
  skipMode: 'MAINTAIN_TERM',
  lumpMode: 'REDUCE_INSTALLMENT',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── listLoans ─────────────────────────────────────────────────────────────────

describe('listLoans — cross-tenant isolation', () => {
  it('scopes SELECT to the caller company_id', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await listLoans(COMPANY_ID);
    // Capture template-literal args — companyId must appear in the SQL bindings
    const call = sqlMock.mock.calls[0];
    const bindings = Array.isArray(call) ? call.slice(1).flat() : [];
    expect(bindings).toContain(COMPANY_ID);
  });
});

describe('listLoans', () => {
  it('returns mapped loans for company', async () => {
    sqlMock.mockResolvedValueOnce([makeLoanRow()]);
    const loans = await listLoans(COMPANY_ID);
    expect(loans).toHaveLength(1);
    expect(loans[0]).toMatchObject({
      id: LOAN_ID,
      companyId: COMPANY_ID,
      principal: 224_873.49,
      rateMode: 'PRIME_PLUS',
      margin: 4,
      termMonths: 72,
      status: 'active',
    });
  });

  it('returns empty array when no loans', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const loans = await listLoans(COMPANY_ID);
    expect(loans).toEqual([]);
  });

  it('filters by status when provided', async () => {
    sqlMock.mockResolvedValueOnce([makeLoanRow({ status: 'closed' })]);
    const loans = await listLoans(COMPANY_ID, { status: 'closed' });
    expect(loans[0]!.status).toBe('closed');
  });
});

// ── getLoanById ───────────────────────────────────────────────────────────────

describe('getLoanById', () => {
  it('returns loan when found for company', async () => {
    sqlMock.mockResolvedValueOnce([makeLoanRow()]);
    const loan = await getLoanById(COMPANY_ID, LOAN_ID);
    expect(loan).not.toBeNull();
    expect(loan!.id).toBe(LOAN_ID);
  });

  it('returns null when loan not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const loan = await getLoanById(COMPANY_ID, LOAN_ID);
    expect(loan).toBeNull();
  });
});

// ── createLoan ────────────────────────────────────────────────────────────────

describe('createLoan', () => {
  it('inserts and returns new loan', async () => {
    sqlMock.mockResolvedValueOnce([makeLoanRow()]);
    const loan = await createLoan(COMPANY_ID, VALID_CREATE);
    expect(loan).toMatchObject({ companyId: COMPANY_ID, principal: 224_873.49 });
  });

  it('throws when principal is not positive', async () => {
    await expect(
      createLoan(COMPANY_ID, { ...VALID_CREATE, principal: 0 }),
    ).rejects.toThrow('principal');
  });

  it('throws when termMonths is not positive', async () => {
    await expect(
      createLoan(COMPANY_ID, { ...VALID_CREATE, termMonths: 0 }),
    ).rejects.toThrow('termMonths');
  });

  it('throws when FIXED rate mode has no fixedRate', async () => {
    await expect(
      createLoan(COMPANY_ID, { ...VALID_CREATE, rateMode: 'FIXED', fixedRate: undefined }),
    ).rejects.toThrow('fixedRate');
  });

  it('maps recurringSkipMonths array correctly', async () => {
    sqlMock.mockResolvedValueOnce([makeLoanRow()]);
    const loan = await createLoan(COMPANY_ID, VALID_CREATE);
    expect(loan.recurringSkipMonths).toEqual([12, 1]);
  });
});

// ── updateLoan ────────────────────────────────────────────────────────────────

describe('updateLoan', () => {
  it('updates status and returns updated loan', async () => {
    sqlMock.mockResolvedValueOnce([makeLoanRow({ status: 'closed' })]);
    const loan = await updateLoan(COMPANY_ID, LOAN_ID, { status: 'closed' });
    expect(loan!.status).toBe('closed');
  });

  it('returns null when loan not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const loan = await updateLoan(COMPANY_ID, LOAN_ID, { status: 'closed' });
    expect(loan).toBeNull();
  });
});

// ── addLoanEvent ──────────────────────────────────────────────────────────────

describe('addLoanEvent', () => {
  it('inserts and returns new event', async () => {
    sqlMock.mockResolvedValueOnce([makeLoanRow()]);        // loan exists check
    sqlMock.mockResolvedValueOnce([makeEventRow()]);       // insert
    const event = await addLoanEvent(COMPANY_ID, LOAN_ID, USER_ID, {
      kind: 'SKIP',
      date: '2026-05-15',
    });
    expect(event).toMatchObject({ kind: 'SKIP', loanId: LOAN_ID });
  });

  it('throws when loan not found', async () => {
    sqlMock.mockResolvedValueOnce([]);  // loan not found
    await expect(
      addLoanEvent(COMPANY_ID, LOAN_ID, USER_ID, { kind: 'SKIP', date: '2026-05-15' }),
    ).rejects.toThrow('not found');
  });

  it('throws when LUMP event has no amount', async () => {
    await expect(
      addLoanEvent(COMPANY_ID, LOAN_ID, USER_ID, { kind: 'LUMP', date: '2026-06-15' }),
    ).rejects.toThrow('amount');
  });

  it('throws when LUMP amount is not positive', async () => {
    await expect(
      addLoanEvent(COMPANY_ID, LOAN_ID, USER_ID, { kind: 'LUMP', date: '2026-06-15', amount: -100 }),
    ).rejects.toThrow('amount');
  });
});

// ── getLoanEvents ─────────────────────────────────────────────────────────────

describe('getLoanEvents', () => {
  it('returns events sorted by date', async () => {
    sqlMock.mockResolvedValueOnce([
      makeEventRow({ event_date: '2026-07-15', kind: 'LUMP', amount: '75000' }),
      makeEventRow({ event_date: '2026-05-15', kind: 'SKIP' }),
    ]);
    const events = await getLoanEvents(COMPANY_ID, LOAN_ID);
    expect(events[0]!.date).toBe('2026-05-15');
    expect(events[1]!.kind).toBe('LUMP');
    expect(events[1]!.amount).toBe(75_000);
  });

  it('returns empty array when no events', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const events = await getLoanEvents(COMPANY_ID, LOAN_ID);
    expect(events).toEqual([]);
  });
});
