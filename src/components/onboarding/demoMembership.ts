/**
 * Which membership is the demo company. Always `isDemo`, never the name: a
 * customer may call their own company "Demo Plumbing" and must not be sent
 * into the sandbox (or offered a switch away from their own books).
 */
import type { CompanyUser } from '@/contexts/companyModel';

/** The demo membership to offer, or null when none exists or the user is already on it. */
export function findDemoMembership(
  companies: readonly CompanyUser[],
  activeCompanyId: string | null | undefined,
): CompanyUser | null {
  const demo = companies.find((c) => c.isDemo === true);
  if (!demo || demo.companyId === activeCompanyId) return null;
  return demo;
}
