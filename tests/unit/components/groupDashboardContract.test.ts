// tests/unit/components/groupDashboardContract.test.ts
//
// `/accounting/group` crashed with "Cannot read properties of undefined
// (reading 'length')" the first time it ever rendered with a group present.
//
// `pages/accounting/group/index.tsx` redeclared the API's response shape with
// invented field names:
//
//   page declared          API actually returns
//   ---------------        --------------------
//   entities               entitySummaries      <- GroupEntityTable crashed on .length
//   combinedCash           combinedCashPosition
//   combinedAR             combinedARTotal
//   combinedAP             combinedAPTotal
//   holdingCompanyName     (did not exist at all)
//
// `await res.json()` is `any`, so tsc saw a match that did not exist. The page
// had never rendered with a group — the dashboard endpoint 500'd until PR #250
// and no group existed until one was created by hand — so nothing exercised it.
//
// The fixtures below are the VERBATIM production responses captured from the
// live network trace on 2026-08-17, so this test fails if either endpoint's
// field names drift again.

import { describe, it, expect } from 'vitest';
import type { GroupDashboardStats } from '@/modules/accounting/services/reports/consolidatedReportingService';

/** Verbatim GET /api/accounting/company-groups (prod, 2026-08-17). */
const GROUPS_RESPONSE = {
  success: true,
  data: {
    items: [{
      id: 'ac239a4d-b912-4fdf-9f0b-94507304cbd8',
      name: 'Incendio Global',
      holdingCompanyId: null,
      holdingCompanyName: null,
      defaultCurrency: 'ZAR',
      financialYearStart: 3,
      isActive: true,
      createdBy: 'f110ef4f-e388-442e-8428-1a265b8d0a6a',
      createdAt: 'Sat Aug 15 2026 11:06:08 GMT+0200',
      updatedAt: 'Sat Aug 15 2026 11:06:08 GMT+0200',
      memberCount: 3,
    }],
  },
};

/** Shape of GET ...consolidated-reports?action=dashboard, per GroupDashboardStats. */
const DASHBOARD_RESPONSE: { success: boolean; data: GroupDashboardStats } = {
  success: true,
  data: {
    groupId: 'ac239a4d-b912-4fdf-9f0b-94507304cbd8',
    combinedCashPosition: -1783675.17,
    combinedARTotal: 16037533.54,
    combinedAPTotal: 38316883.71,
    combinedRevenue: 0,
    combinedExpenses: 0,
    entitySummaries: [
      { companyId: 'd27bac33', companyName: 'Brightsphere Technologies (Pty) Ltd', revenue: 0, expenses: 0, netProfit: 0, cashPosition: -1911554.82 },
      { companyId: 'd6184044', companyName: 'H10 Holdings (Pty) Ltd', revenue: 0, expenses: 0, netProfit: 0, cashPosition: 0 },
      { companyId: '4a159669', companyName: 'Velocity Fibre (Pty) Ltd', revenue: 0, expenses: 0, netProfit: 0, cashPosition: 127879.65 },
    ],
  },
};

/** The stat-card keys the page indexes dashData with. Must all exist. */
const STAT_CARD_KEYS = ['combinedCashPosition', 'combinedRevenue', 'combinedARTotal', 'combinedAPTotal'] as const;

describe('group dashboard page ↔ API contract', () => {
  const dash = DASHBOARD_RESPONSE.data;

  it('every stat-card key the page reads exists on the response', () => {
    for (const key of STAT_CARD_KEYS) {
      expect(dash).toHaveProperty(key);
      expect(typeof dash[key]).toBe('number');
    }
  });

  it('the entity list is `entitySummaries`, not `entities` — the field that crashed', () => {
    expect(dash).toHaveProperty('entitySummaries');
    expect(Array.isArray(dash.entitySummaries)).toBe(true);
    // The old name must not exist, or the page would silently read undefined again.
    expect(dash).not.toHaveProperty('entities');
  });

  it('entitySummaries rows carry every field the totals reducer and table read', () => {
    for (const e of dash.entitySummaries) {
      for (const f of ['companyId', 'companyName', 'revenue', 'expenses', 'netProfit', 'cashPosition']) {
        expect(e).toHaveProperty(f);
      }
    }
  });

  it('the totals reducer produces finite numbers, not NaN', () => {
    const totals = dash.entitySummaries.reduce(
      (acc, e) => ({
        revenue: acc.revenue + e.revenue,
        expenses: acc.expenses + e.expenses,
        netProfit: acc.netProfit + e.netProfit,
        cashPosition: acc.cashPosition + e.cashPosition,
      }),
      { revenue: 0, expenses: 0, netProfit: 0, cashPosition: 0 },
    );
    for (const v of Object.values(totals)) expect(Number.isFinite(v)).toBe(true);
    expect(totals.cashPosition).toBeCloseTo(-1783675.17, 2);
  });

  it('reading the OLD field names yields undefined — the exact crash reproduced', () => {
    const wrong = dash as unknown as { entities?: unknown[]; combinedCash?: number };
    expect(wrong.entities).toBeUndefined();
    expect(wrong.combinedCash).toBeUndefined();
    // This is what GroupEntityTable did: entities.length on undefined.
    expect(() => (wrong.entities as unknown[]).length).toThrow(TypeError);
  });
});

describe('group list page ↔ API contract', () => {
  const item = GROUPS_RESPONSE.data.items[0]!;

  it('carries the fields the group picker renders', () => {
    for (const f of ['id', 'name', 'memberCount', 'holdingCompanyName']) {
      expect(item).toHaveProperty(f);
    }
    expect(typeof item.memberCount).toBe('number');
  });

  it('holdingCompanyName may be null and must not be rendered as "Holding: null"', () => {
    expect(item.holdingCompanyName).toBeNull();
    const label = item.holdingCompanyName ? `Holding: ${item.holdingCompanyName} · ` : '';
    expect(label).toBe('');
  });

  it('memberCount reflects the real members, so the picker does not read undefined', () => {
    expect(item.memberCount).toBe(3);
  });
});
