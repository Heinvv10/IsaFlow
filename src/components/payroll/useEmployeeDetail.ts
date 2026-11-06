/**
 * State and handlers of /payroll/employees/[id]: the employee, the component catalogue, their assignments, and the
 * writes that reload them. The page only lays out cards.
 */
import { useEffect, useState, useCallback } from 'react';
import { apiErrorMessage, apiFetch, assertOk, ApiEnvelopeError } from '@/lib/apiFetch';
import type { Employee } from '@/components/payroll/EmployeeProfileCard';
import type { Component, Assignment } from '@/components/payroll/EmployeeComponentsCard';
import { localISODate } from '@/lib/dateUtils';
import { payrollLoadMessage } from '@/lib/payrollDetailAccess';

export function useEmployeeDetail(employeeId: string) {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [components, setComponents] = useState<Component[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  /** The tax number as stored: the readiness card must not turn green on an edit that is not saved yet. */
  const [savedTaxNumber, setSavedTaxNumber] = useState<string | undefined>(undefined);

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
      setSavedTaxNumber(((eJson.data ?? eJson) as Employee).taxNumber);
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
      setSavedTaxNumber(employee.taxNumber);
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

  const editAssignmentDates = async (assignmentId: string, effectiveFrom: string, effectiveTo: string | null) => {
    setError('');
    try {
      const res = await apiFetch(
        `/api/payroll/employees/${employeeId}/components?aid=${assignmentId}`,
        { method: 'PATCH', body: JSON.stringify({ effectiveFrom, effectiveTo }) },
      );
      await assertOk(res, 'Could not change the dates - try again');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not change the dates - try again'));
      return;
    }
    await loadAll();
  };

  return {
    employee, setEmployee, savedTaxNumber, components, assignments, isLoading, error, savingProfile,
    newComponentId, setNewComponentId, newAmount, setNewAmount, newFrom, setNewFrom, newIsRecurring, setNewIsRecurring,
    addingAssignment, saveProfile, assignComponent, endAssignment, editAssignmentDates,
  };
}
