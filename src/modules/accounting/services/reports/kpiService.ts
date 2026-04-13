/**
 * KPI Service — Facade
 * Re-exports from kpiDashboardService and kpiChartsService
 * for backward compatibility.
 */

export type { DashboardKPIs } from './kpiDashboardService';
export { getDashboardKPIs } from './kpiDashboardService';

export type {
  ChartPoint,
  CashFlowPoint,
  AgingBreakdownBucket,
  TopCustomer,
  TopExpenseCategory,
} from './kpiChartsService';

export {
  getRevenueChart,
  getCashFlowChart,
  getAgingBreakdown,
  getTopCustomers,
  getTopExpenseCategories,
} from './kpiChartsService';
