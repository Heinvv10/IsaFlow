// src/modules/accounting/services/afs/afsKpiTypes.ts

// ── KPI Scorecard ───────────────────────────────────────────────────────────

export interface RagThresholds {
  [key: string]: { green: number; amber: number; lowerIsBetter: boolean };
}

export interface KpiResult {
  key: string;
  label: string;
  value: number;
  formatted: string;
  rag: 'green' | 'amber' | 'red';
  trend: 'up' | 'down' | 'flat';
  priorValue: number | null;
}

export interface KpiScorecard {
  period: string;
  companyId: string;
  kpis: KpiResult[];
  generatedAt: string;
}

export interface FinancialSnapshot {
  revenue: number;
  cogs: number;
  grossProfit: number;
  ebitda: number;
  ebit: number;
  netProfit: number;
  currentAssets: number;
  currentLiabilities: number;
  inventory: number;
  tradeReceivables: number;
  tradePayables: number;
  totalDebt: number;
  totalEquity: number;
  openingCash: number;
  closingCash: number;
  daysInPeriod: number;
}
