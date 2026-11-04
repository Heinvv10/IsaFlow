/**
 * The budget routes of the route registry (budgets P1-P5), kept beside `apiRoutes.ts` so the
 * registry stays under the file-size limit; `StaticRoutes` and `DynamicRoutes` there extend these.
 * Same rules as the registry: one type per URL, taken from the service, `{}` binds one segment.
 * Every import is `import type`.
 */
import type { BudgetVersion } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { GridCellsOnly, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import type { RemainingResult } from '@/modules/accounting/services/budgets/remainingBudgetCore';
import type { BudgetAlertList } from '@/modules/accounting/services/budgets/budgetAlertList';
import type { ControlsView, EvaluateNowResult } from '@/modules/accounting/services/budgets/budgetControlsApi';
import type { OverrideRow } from '@/modules/accounting/services/budgets/budgetControlSettings';
import type { SliceReview } from '@/modules/accounting/services/budgets/sliceReviewRead';
import type { VarianceNote } from '@/modules/accounting/services/commentary/varianceNoteTypes';
import type { SaveCellsResult } from '@/modules/accounting/services/budgets/gridSave';
import type { SeedResult } from '@/modules/accounting/services/budgets/seedVersion';
import type { ImportPreview } from '@/modules/accounting/services/budgets/budgetImportDiff';
import type { DriverHeadcountResponse, DriverOverrideResponse, DriversResponse, PlannedHiresResponse, ReforecastResponse } from '@/modules/accounting/services/budgets/drivers/driverApiTypes';

export interface BudgetStaticRoutes {
  // Budget versions (mig 947): GET the list, POST the new draft (the list and the item of one resource, a union).
  '/api/accounting/budget-versions': { items: BudgetVersion[] } | BudgetVersion;
  // Budget grid (P2): GET read model, or `cells_only=1` the cells and token.
  '/api/accounting/budget-grid': GridReadModel | GridCellsOnly;
  '/api/accounting/budget-grid/prior-actuals': PriorActuals;
  '/api/accounting/budget-grid/save': SaveCellsResult;
  '/api/accounting/budget-grid/seed': SeedResult;
  '/api/accounting/budget-grid/import-preview': ImportPreview;
  // PUT: the note as stored (trimmed; null when cleared). Year-scoped (P2 follow-up F1).
  '/api/accounting/budget-grid/note': { note: string | null };
  '/api/accounting/budget-drivers': DriversResponse;
  '/api/accounting/budget-drivers/override': DriverOverrideResponse;
  '/api/accounting/budget-drivers/headcount': DriverHeadcountResponse;
  '/api/accounting/budget-drivers/planned-hires': PlannedHiresResponse;
  // Budgets P5-1: remaining-budget preview (POST).
  '/api/accounting/budgets/remaining': { lines: RemainingResult[] };
  // Budgets P5-4: controls GET/PUT (one view), threshold overrides POST (the item) / DELETE, alerts list, Evaluate now.
  '/api/accounting/budgets/controls': ControlsView;
  '/api/accounting/budgets/controls/thresholds': { override: OverrideRow } | { deleted: true };
  '/api/accounting/budgets/alerts': BudgetAlertList;
  '/api/accounting/budgets/alerts/evaluate': EvaluateNowResult;
  // Budgets P5-5: GET the month's notes; POST saves, approves or rejects one.
  '/api/accounting/budgets/variance-notes': { notes: VarianceNote[] } | { note: VarianceNote };
  // Budgets P5-6: GET the slices (owner/admin every one, others their own); POST assigns a holder and answers the
  // slice; DELETE unassigns one (`{ removed, sliceDeleted }`).
  '/api/accounting/budgets/holders': { slices: SliceReview[] } | SliceReview | { removed: true; sliceDeleted: boolean };
}

export interface BudgetDynamicRoutes {
  // Budget versions (mig 947): GET the version or DELETE `{ deleted }` (a union); status/copy/primary return it; P4's reforecast a union.
  '/api/accounting/budget-versions/{}': BudgetVersion | { deleted: true };
  '/api/accounting/budget-versions/{}/status': BudgetVersion;
  '/api/accounting/budget-versions/{}/copy': BudgetVersion;
  '/api/accounting/budget-versions/{}/primary': BudgetVersion;
  '/api/accounting/budget-versions/{}/reforecast': ReforecastResponse;
  // Budgets P5-6: a slice's review moves (POST only), each answering the slice.
  '/api/accounting/budgets/slices/{}/submit': SliceReview;
  '/api/accounting/budgets/slices/{}/approve': SliceReview;
  '/api/accounting/budgets/slices/{}/return': SliceReview;
}
