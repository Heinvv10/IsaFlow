/**
 * Renders its children only for the roles that may write payroll (owner, admin, manager — the set the
 * server enforces). A viewer, or a role not known yet, sees nothing: no button that would only answer 403.
 */
import type { ReactNode } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';

export function WriteOnly({ children }: { children: ReactNode }) {
  const { companyRole } = useCompany();
  return canWrite(companyRole) ? <>{children}</> : null;
}
