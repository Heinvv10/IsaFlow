/**
 * Budget controls (budgets P5-4): approval check policy, alert thresholds and the overspend alerts
 * (bell only, no email digest). The body is BudgetControlsPage; this page only frames it.
 */
import { AppLayout } from '@/components/layout/AppLayout';
import { BudgetControlsPage } from '@/components/accounting/budgets/controls/BudgetControlsPage';

export default function BudgetControls() {
  return (
    <AppLayout>
      <BudgetControlsPage />
    </AppLayout>
  );
}
