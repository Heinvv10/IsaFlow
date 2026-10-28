/**
 * Golden Paths slots: the constants, the dev-database guard and the env-file helpers behind
 * scripts/ci/golden/provision-slots.ts. Pure, so tests/unit/ci/goldenSlotConfig.test.ts can pin them.
 *
 * A slot is a company of its own on isaflow_dev plus a golden user who is its only member. The golden-paths job in
 * .github/workflows/ci.yml maps each runner to one slot and reads GOLDEN_SLOT_n_* from /home/hein/isaflow-ci.env.
 */

export const GOLDEN_SLOTS = [1, 2, 3] as const;
export type GoldenSlotNumber = (typeof GOLDEN_SLOTS)[number];

/** The seeded Demo company: the golden suite's company before slots, and what each slot is cloned from. */
export const SOURCE_COMPANY_ID = '00000000-0000-0000-0000-000000000001';

/** The only database the provisioner writes to. Production is `isaflow` on the same host and port. */
export const DEV_DATABASE = 'isaflow_dev';

/** Version-4 ids ("601d" for golden), so zod's strict uuid() accepts them, unlike the seeded Demo id. */
export const slotCompanyId = (n: number): string => `601d0000-0000-4000-8000-00000000000${n}`;
export const slotCompanyName = (n: number): string => `Golden Slot ${n} (CI fixture)`;
export const slotEmail = (n: number): string => `golden-slot-${n}@isaflow.dev`;

export interface SlotEnvKeys { companyId: string; email: string; password: string }
export const slotEnvKeys = (n: number): SlotEnvKeys => ({
  companyId: `GOLDEN_SLOT_${n}_COMPANY_ID`,
  email: `GOLDEN_SLOT_${n}_EMAIL`,
  password: `GOLDEN_SLOT_${n}_PASSWORD`,
});

/**
 * Throws unless `url` names database `allowed` (default isaflow_dev) as its path. Only the path counts: the same host
 * and port serve production, a query string cannot select a database, and the message never echoes the url (it
 * carries a password).
 */
export function assertDevDatabaseUrl(url: string, allowed: string = DEV_DATABASE): void {
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`the database url does not parse; the provisioner only runs against ${allowed}`);
  }
  if (name !== allowed) {
    throw new Error(`refusing to provision: the database url names "${name || '(none)'}", the provisioner only runs against ${allowed}`);
  }
}

/** KEY=value lines (no quote handling: values are returned as written). Comments and blank lines are ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * Sets each key, replacing its line where one exists and appending otherwise. Every other line stays byte for byte:
 * the file also holds the app's own secrets, and values in it are not valid shell (SMTP_FROM), so it is never rewritten
 * from a parsed copy.
 */
export function upsertEnvKeys(text: string, entries: Record<string, string>): string {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  for (const [key, value] of Object.entries(entries)) {
    if (/[\r\n]/.test(value)) throw new Error(`value for ${key} contains a newline`);
    const at = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}
