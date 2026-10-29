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

/**
 * Where a failure's remedy has to be applied: the slot company and user, and the command that rebuilds the slot, or
 * the default Demo company when no slot is set. Used in messages that tell a human which company to fix.
 */
export function describeGoldenCompany(env: Record<string, string | undefined>): string {
  const companyId = env.GOLDEN_COMPANY_ID;
  if (!companyId) return 'the Demo company';
  const email = env.GOLDEN_USER_EMAIL ?? 'unknown';
  const n = /^golden-slot-(\d)@/.exec(email)?.[1];
  // --reset-slot refuses to run without --seed-url: a rebuilt slot without the GSEED data fails the volume specs.
  const rebuild = n ? `, or rebuild the slot with: bun scripts/ci/golden/provision-slots.ts --reset-slot ${n} --seed-url http://localhost:<dev server port, 3300-3799>` : '';
  return `GOLDEN SLOT${n ? ` ${n}` : ''} company ${companyId} (user ${email})${rebuild}`;
}
