/**
 * The Golden Paths slot a run belongs to.
 *
 * CI gives every runner a company of its own on isaflow_dev and a golden user for it (scripts/ci/golden/provision-slots.ts),
 * so runs on different runners never write to the same books. The golden-paths job turns the runner into these three
 * variables. With none set (the post-deploy run against production, a local run) there is no slot: the suite logs in as
 * E2E_ADMIN_* and works in that user's default company, exactly as before slots existed.
 */

export interface GoldenSlot {
  companyId: string;
  email: string;
  password: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = ['GOLDEN_COMPANY_ID', 'GOLDEN_USER_EMAIL', 'GOLDEN_USER_PASSWORD'] as const;

/**
 * @returns the slot, or null when none of the three variables is set.
 * @throws when only some are set: falling back to the default company then would put two runs back on one company.
 */
export function readGoldenSlot(env: Record<string, string | undefined>): GoldenSlot | null {
  const [companyId, email, password] = KEYS.map((k) => env[k] ?? '');
  if (!companyId && !email && !password) return null;
  if (!companyId || !email || !password) {
    throw new Error(`a golden slot needs GOLDEN_COMPANY_ID, GOLDEN_USER_EMAIL and GOLDEN_USER_PASSWORD together; missing: ${KEYS.filter((k) => !env[k]).join(', ')}`);
  }
  if (!UUID.test(companyId)) throw new Error(`GOLDEN_COMPANY_ID must be a uuid, got "${companyId}"`);
  return { companyId, email, password };
}
