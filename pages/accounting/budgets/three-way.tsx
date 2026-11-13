/**
 * Three-way budget (budgets P6 spec §8): one budget version's budgeted balance sheet and cash flow, its cash
 * runway, assumptions and a compare of up to three versions. Behind the `budgets_three_way` flag: a company
 * without it sees a plain note (not an upgrade prompt, §13.13), and every API route answers 403 anyway.
 */
import { AppLayout } from '@/components/layout/AppLayout';
import { FeatureGate } from '@/components/admin/FeatureGate';
import { ThreeWayPage } from '@/components/accounting/budgets/threeWay/ThreeWayPage';

function NotEnabled() {
  return (
    <div className="mx-auto max-w-3xl p-6" data-testid="three-way-not-enabled">
      <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Three-way budget</h1>
      <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">The three-way budget is not available for this company.</p>
    </div>
  );
}

export default function ThreeWayBudgetPage() {
  return (
    <AppLayout>
      <FeatureGate feature="budgets_three_way" fallback={<NotEnabled />}>
        <ThreeWayPage />
      </FeatureGate>
    </AppLayout>
  );
}
