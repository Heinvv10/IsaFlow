/**
 * Budget controls (budgets P5-4): approval check policy, alert thresholds, the email digest switch
 * and the overspend alerts. The body is BudgetControlsPage; this page only frames it.
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
