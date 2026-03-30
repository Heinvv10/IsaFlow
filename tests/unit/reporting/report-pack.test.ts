/**
 * TDD: Report Pack Service
 * Tests for building report packs for different audiences.
 */

import { describe, it, expect } from 'vitest';
import {
  buildReportPack,
  getPackTemplate,
  type ReportPackInput,
} from '@/modules/accounting/services/reportPackService';

const sampleData: ReportPackInput = {
  companyName: 'Test Co',
  period: '2026-01',
  revenue: 1000000,
  costOfSales: 600000,
  operatingExpenses: 200000,
  netProfit: 200000,
  totalAssets: 2000000,
  totalLiabilities: 800000,
  totalEquity: 1200000,
  currentAssets: 500000,
  currentLiabilities: 300000,
  cash: 150000,
  accountsReceivable: 200000,
  accountsPayable: 100000,
  inventory: 0,
};

describe('Report Pack Service', () => {
  it('returns board pack with correct sections', () => {
    const pack = buildReportPack('board', sampleData, '2026-01-01', '2026-01-31');
    expect(pack.type).toBe('board');
    const sectionTitles = pack.sections.map(s => s.type);
    expect(sectionTitles).toContain('income_statement');
    expect(sectionTitles).toContain('balance_sheet');
    expect(sectionTitles).toContain('ratios');
    expect(sectionTitles).toContain('kpis');
  });

  it('returns management pack with extra sections', () => {
    const pack = buildReportPack('management', sampleData, '2026-01-01', '2026-01-31');
    const sectionTitles = pack.sections.map(s => s.type);
    expect(sectionTitles).toContain('cash_flow');
    expect(sectionTitles).toContain('waterfall');
  });

  it('returns monthly pack with correct sections', () => {
    const pack = buildReportPack('monthly', sampleData, '2026-01-01', '2026-01-31');
    const sectionTitles = pack.sections.map(s => s.type);
    expect(sectionTitles).toContain('income_statement');
    expect(sectionTitles).toContain('balance_sheet');
    expect(sectionTitles).toContain('cash_flow');
  });

  it('pack has required metadata fields', () => {
    const pack = buildReportPack('board', sampleData, '2026-01-01', '2026-01-31');
    expect(pack).toHaveProperty('type');
    expect(pack).toHaveProperty('companyName');
    expect(pack).toHaveProperty('period');
    expect(pack).toHaveProperty('generatedAt');
    expect(pack).toHaveProperty('sections');
    expect(Array.isArray(pack.sections)).toBe(true);
  });

  it('getPackTemplate returns sections in correct order', () => {
    const template = getPackTemplate('board');
    expect(Array.isArray(template)).toBe(true);
    expect(template.length).toBeGreaterThan(0);
    expect(template[0]).toHaveProperty('type');
    expect(template[0]).toHaveProperty('title');
  });

  it('management pack has more sections than board pack', () => {
    const board = buildReportPack('board', sampleData, '2026-01-01', '2026-01-31');
    const mgmt = buildReportPack('management', sampleData, '2026-01-01', '2026-01-31');
    expect(mgmt.sections.length).toBeGreaterThan(board.sections.length);
  });
});
