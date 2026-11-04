/**
 * Budget Review (budgets P5-6): the budget-holder slice board for owners and admins, and "My budget
 * slices" for a holder. The board is BudgetReviewPage; this page only frames it.
 */
import { AppLayout } from '@/components/layout/AppLayout';
import { BudgetReviewPage } from '@/components/accounting/budgets/review/BudgetReviewPage';

export default function BudgetReview() {
  return (
    <AppLayout>
      <BudgetReviewPage />
    </AppLayout>
  );
}
