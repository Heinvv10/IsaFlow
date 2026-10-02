/**
 * Payroll Employee Detail + Edit + Components — Phase 2.
 * Route: /payroll/employees/[id]
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiErrorMessage, apiFetch, assertOk, ApiEnvelopeError } from '@/lib/apiFetch';
import { User, ArrowLeft, Loader2, AlertCircle } from 'lucide-react';
import { EmployeeProfileCard, type Employee } from '@/components/payroll/EmployeeProfileCard';
import {
  EmployeeComponentsCard,
  type Component,
  type Assignment,
} from '@/components/payroll/EmployeeComponentsCard';
import { EmployeeTerminationCard } from '@/components/payroll/EmployeeTerminationCard';
import { CostCentreAssignmentCard } from '@/components/payroll/CostCentreAssignmentCard';
import { EmployeeHistoryCard } from '@/components/payroll/EmployeeHistoryCard';
import { PayScaleCard } from '@/components/payroll/PayScaleCard';
import { ApplyPackageCard } from '@/components/payroll/ApplyPackageCard';
import { OccupationalLevelCard } from '@/components/payroll/OccupationalLevelCard';
import { localISODate } from '@/lib/dateUtils';
import { payrollLoadMessage, NO_PAYROLL_DETAIL_ACCESS } from '@/lib/payrollDetailAccess';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';

export default function EmployeeDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const employeeId = typeof id === 'string' ? id : '';
  const { companyRole } = useCompany();
  const mayWrite = canWrite(companyRole); // the API sends a viewer names only; the cards below are all personal or pay detail

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [components, setComponents] = useState<Component[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  const [newComponentId, setNewComponentId] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newFrom, setNewFrom] = useState(localISODate());
  const [newIsRecurring, setNewIsRecurring] = useState(true);
  const [addingAssignment, setAddingAssignment] = useState(false);

  const loadAll = useCallback(async () => {
    if (!employeeId) return;
    setIsLoading(true);
    setError('');
    try {
      const [eRes, cRes, aRes] = await Promise.all([
        apiFetch(`/api/payroll/employees/${employeeId}`),
        apiFetch('/api/payroll/components'),
        apiFetch(`/api/payroll/employees/${employeeId}/components`),
      ]);
      if (eRes.status === 403) throw new ApiEnvelopeError(payrollLoadMessage(403, 'Could not load this employee - try again'));
      await assertOk(eRes, 'Could not load this employee - try again');
      const eJson = await eRes.json();
      if (!cRes.ok) setError(payrollLoadMessage(cRes.status, 'Could not load the payroll components - try again'));
      const cJson = cRes.ok ? await cRes.json() : { data: [] };
      if (!aRes.ok) setError(payrollLoadMessage(aRes.status, 'Could not load the employee components - try again'));
      const aJson = aRes.ok ? await aRes.json() : { data: [] };
      setEmployee((eJson.data ?? eJson) as Employee);
      setComponents((cJson.data ?? cJson) as Component[]);
      setAssignments((aJson.data ?? aJson) as Assignment[]);
    } catch (err) {
      setEmployee(null); setComponents([]); setAssignments([]);
      setError(apiErrorMessage(err, 'Could not load this employee - try again'));
    } finally {
      setIsLoading(false);
    }
  }, [employeeId]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const saveProfile = async () => {
    if (!employee) return;
    setSavingProfile(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/employees/${employee.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: employee.firstName,
          lastName: employee.lastName,
          employmentType: employee.employmentType,
          taxNumber: employee.taxNumber,
          idNumber: employee.idNumber,
          dateOfBirth: employee.dateOfBirth,
          endDate: employee.endDate,
          uifExcluded: employee.uifExcluded,
          medicalAidMainMember: employee.medicalAidMainMember,
          medicalAidDependantsCount: employee.medicalAidDependantsCount,
        }),
      });
      await assertOk(res, 'Could not save the employee - try again');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the employee - try again'));
    } finally {
      setSavingProfile(false);
    }
  };

  const assignComponent = async () => {
    if (!newComponentId || !newAmount) return;
    setAddingAssignment(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/components`, {
        method: 'POST',
        body: JSON.stringify({
          componentId: newComponentId,
          amount: Number(newAmount),
          effectiveFrom: newFrom,
          isRecurring: newIsRecurring,
        }),
      });
      await assertOk(res, 'Could not assign the component - try again');
      setNewComponentId(''); setNewAmount('');
      await loadAll();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not assign the component - try again'));
    } finally {
      setAddingAssignment(false);
    }
  };

  const endAssignment = async (assignmentId: string) => {
    const today = localISODate();
    setError('');
    try {
      const res = await apiFetch(
        `/api/payroll/employees/${employeeId}/components?aid=${assignmentId}`,
        { method: 'DELETE', body: JSON.stringify({ effectiveTo: today }) },
      );
      await assertOk(res, 'Could not end this component - try again');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not end this component - try again'));
      return;
    }
    await loadAll();
  };

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
            <Link href="/payroll/employees" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <User className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">
                {employee.firstName} {employee.lastName}
              </h1>
              <p className="text-sm text-[var(--ff-text-secondary)] font-mono">{employee.employeeNumber}</p>
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
            <EmployeeProfileCard
              employee={employee}
              onChange={setEmployee}
              onSave={saveProfile}
              saving={savingProfile}
            />

            <EmployeeComponentsCard
              components={components}
              assignments={assignments}
              newComponentId={newComponentId}
              newAmount={newAmount}
              newFrom={newFrom}
              newIsRecurring={newIsRecurring}
              onNewComponentId={setNewComponentId}
              onNewAmount={setNewAmount}
              onNewFrom={setNewFrom}
              onNewIsRecurring={setNewIsRecurring}
              onAssign={assignComponent}
              onEnd={endAssignment}
              adding={addingAssignment}
            />

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

            {employeeId && <EmployeeTerminationCard employeeId={employeeId} endDate={employee.endDate ?? null} />}

            {employeeId && <EmployeeHistoryCard employeeId={employeeId} />}
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
