/**
 * Payroll Employee Detail + Edit + Components — Phase 2.
 * Route: /payroll/employees/[id]
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useEmployeeDetail } from '@/components/payroll/useEmployeeDetail';
import { User, ArrowLeft, Loader2, AlertCircle } from 'lucide-react';
import { EmployeeProfileCard } from '@/components/payroll/EmployeeProfileCard';
import { EmployeeWorkCard } from '@/components/payroll/EmployeeWorkCard';
import { EmployeeComponentsCard } from '@/components/payroll/EmployeeComponentsCard';
import { EmployeeTerminationCard } from '@/components/payroll/EmployeeTerminationCard';
import { CostCentreAssignmentCard } from '@/components/payroll/CostCentreAssignmentCard';
import { EmployeeHistoryCard } from '@/components/payroll/EmployeeHistoryCard';
import { EntityHistoryTimeline } from '@/components/accounting/entity-history/EntityHistoryTimeline';
import { PayScaleCard } from '@/components/payroll/PayScaleCard';
import { ApplyPackageCard } from '@/components/payroll/ApplyPackageCard';
import { OccupationalLevelCard } from '@/components/payroll/OccupationalLevelCard';
import { EmployeeReadinessCard } from '@/components/payroll/EmployeeReadinessCard';
import { EmployeeBankCard } from '@/components/payroll/EmployeeBankCard';
import { EmployeeFringeBenefitsCard } from '@/components/payroll/EmployeeFringeBenefitsCard';
import { EmployeeRfiContributionsCard } from '@/components/payroll/EmployeeRfiContributionsCard';
import { EmployeePayslipsCard } from '@/components/payroll/EmployeePayslipsCard';
import { NO_PAYROLL_DETAIL_ACCESS } from '@/lib/payrollDetailAccess';
import { useCompany } from '@/contexts/CompanyContext';
import { canSetPayrollNetPay, canWrite } from '@/lib/auth/writeRoles';

/** The readiness links land here when the card has no field drawn yet; the kit's focus ring shows where focus went. */
const ANCHOR = 'rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2';

export default function EmployeeDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const employeeId = typeof id === 'string' ? id : '';
  const { companyRole } = useCompany();
  const mayWrite = canWrite(companyRole); // the API sends a viewer names only; the cards below are all personal or pay detail

  const [bankVersion, setBankVersion] = useState(0);
  const d = useEmployeeDetail(employeeId);
  const {
    employee, setEmployee, components, assignments, isLoading, error, savingProfile, newComponentId, newAmount, newFrom,
    newIsRecurring, addingAssignment,
  } = d;

  if (isLoading) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)]">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  if (error && !employee) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)] flex-col gap-2">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-red-400 text-sm">{error}</p>
          <Link href="/payroll/employees" className="text-teal-400 text-sm">Back</Link>
        </div>
      </AppLayout>
    );
  }

  if (!employee) return null;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/employees" aria-label="Back to employees" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <User className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">
                {employee.firstName} {employee.lastName}
              </h1>
              <p className="text-sm text-[var(--ff-text-secondary)] font-id">{employee.employeeNumber}</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-6">
          {error && (mayWrite || error !== NO_PAYROLL_DETAIL_ACCESS) && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          {!mayWrite ? (
            <div className="px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm">
              {NO_PAYROLL_DETAIL_ACCESS}
            </div>
          ) : (
            <>
            {employeeId && (
              <EmployeeReadinessCard employeeId={employeeId} refreshKey={bankVersion} assignments={assignments} mayWrite={mayWrite}
                employee={{ taxNumber: d.savedTaxNumber, paymentMethod: employee.paymentMethod }} />
            )}

            <EmployeeProfileCard
              employee={employee}
              onChange={setEmployee}
              onSave={d.saveProfile}
              saving={savingProfile}
            />

            <EmployeeWorkCard key={employee.id} employee={employee} onSaved={setEmployee} canEditPriced={canSetPayrollNetPay(companyRole)} />

            <div id="employee-pay" className={ANCHOR}>
            <EmployeeComponentsCard
              components={components}
              assignments={assignments}
              newComponentId={newComponentId}
              newAmount={newAmount}
              newFrom={newFrom}
              newIsRecurring={newIsRecurring}
              onNewComponentId={d.setNewComponentId}
              onNewAmount={d.setNewAmount}
              onNewFrom={d.setNewFrom}
              onNewIsRecurring={d.setNewIsRecurring}
              onAssign={d.assignComponent}
              onEnd={d.endAssignment}
              onEditDates={d.editAssignmentDates}
              adding={addingAssignment}
            />
            </div>

            {employeeId && mayWrite && <EmployeeRfiContributionsCard employeeId={employeeId} refreshKey={assignments.length} onChanged={() => void d.reload()} onEnd={d.endAssignment} onEditDates={d.editAssignmentDates} />}

            {employeeId && (
              <CostCentreAssignmentCard
                employeeId={employeeId}
                currentCostCentreId={employee.costCentreId ?? null}
                onChange={(id) => setEmployee({ ...employee, costCentreId: id })}
              />
            )}

            {employeeId && (
              <PayScaleCard
                employeeId={employeeId}
                currentPayScaleId={employee.payScaleId ?? null}
                onChange={(id) => setEmployee({ ...employee, payScaleId: id })}
              />
            )}

            {employeeId && <ApplyPackageCard employeeId={employeeId} />}

            {employeeId && (
              <OccupationalLevelCard
                employeeId={employeeId}
                currentLevelId={employee.occupationalLevelId ?? null}
                onChange={(id) => setEmployee({ ...employee, occupationalLevelId: id })}
              />
            )}

            {employeeId && <EmployeeFringeBenefitsCard employeeId={employeeId} />}

            {employeeId && <div id="employee-bank" className={ANCHOR}><EmployeeBankCard employeeId={employeeId} onChanged={() => setBankVersion(v => v + 1)} /></div>}

            {employeeId && <EmployeePayslipsCard employeeId={employeeId} employeeName={`${employee.firstName} ${employee.lastName}`} />}

            {employeeId && <EmployeeTerminationCard employeeId={employeeId} endDate={employee.endDate ?? null} />}

            {employeeId && <EmployeeHistoryCard employeeId={employeeId} />}

            {employeeId && (
              <section className="space-y-2" data-testid="employee-change-history">
                <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Record changes (who changed what)</h3>
                <EntityHistoryTimeline entityType="payroll_employee" entityId={employeeId} />
              </section>
            )}
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
