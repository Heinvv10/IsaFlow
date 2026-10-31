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

/**
 * The only GoTrue the provisioner writes users to. It is ONE instance for dev and production (port 7770): a slot user
 * created here exists for production's login too, with no company there, so it can sign in to prod and see nothing.
 */
export const EXPECTED_GOTRUE_URL = 'http://100.96.203.105:7770/auth/v1';

/**
 * Version-4 ids ("601d" for golden), so zod's strict uuid() accepts them, unlike the seeded Demo id. Generation 0 is the
 * slot's first company; `--reset-slot n` retires it and starts the next generation (1..9) under a new id.
 */
export const MAX_SLOT_GENERATION = 9;
export const slotCompanyId = (n: number, generation = 0): string => `601d000${generation}-0000-4000-8000-00000000000${n}`;
/**
 * No longer than the Demo company's name (22 characters): the shell header is one row tall at 768 and 1024 px only while
 * the company name fits it, and a 26-character slot name made it wrap (s-shell-cls-mobile, 83 px against 56).
 */
export const slotCompanyName = (n: number, generation = 0): string => `Golden Slot ${n}${generation ? ` g${generation}` : ''}`;
export const slotRegistrationNumber = (n: number, generation = 0): string => `GOLDEN/SLOT/${n}${generation ? `/${generation}` : ''}`;
/**
 * Throws unless `id` is a company this slot owns: `slotCompanyId(n, g)` for a generation g in 0..MAX_SLOT_GENERATION.
 * The id comes from the environment (GOLDEN_SLOT_n_COMPANY_ID), and the provisioner renames, retires and adds a golden
 * owner to whatever company it names, so a stray value naming Demo or a real dev tenant must stop it, not be obeyed.
 */
export function assertSlotCompanyId(n: number, id: string): void {
  const own = Array.from({ length: MAX_SLOT_GENERATION + 1 }, (_, g) => slotCompanyId(n, g));
  if (!own.includes(id.toLowerCase())) {
    throw new Error(`slot ${n}: refusing company id ${id}, which is not one of slot ${n}'s (${slotCompanyId(n, 0)} .. ${slotCompanyId(n, MAX_SLOT_GENERATION)}); fix GOLDEN_SLOT_${n}_COMPANY_ID`);
  }
}

/** 0 for a slot's first company, the generation a `--reset-slot` replacement carries; 0 for an id that is not a slot's. */
export const generationOf = (companyId: string): number => Number(/^601d000(\d)-0000-4000-8000-00000000000\d$/.exec(companyId)?.[1] ?? 0);
export const slotEmail = (n: number): string => `golden-slot-${n}@isaflow.dev`;

export interface SlotEnvKeys { companyId: string; email: string; password: string }
export const slotEnvKeys = (n: number): SlotEnvKeys => ({
  companyId: `GOLDEN_SLOT_${n}_COMPANY_ID`,
  email: `GOLDEN_SLOT_${n}_EMAIL`,
  password: `GOLDEN_SLOT_${n}_PASSWORD`,
});

/**
 * Throws unless `url` names database `allowed` (default isaflow_dev) as its path, and carries no query parameter that
 * could name another one. This is the first of two guards: the same host and port serve production, and a driver may
 * honour query parameters over the path, so the real guard is `current_database()` after connecting
 * (provision-slots.ts). The message never echoes the url (it carries a password).
 */
export function assertDevDatabaseUrl(url: string, allowed: string = DEV_DATABASE): void {
  let name = '';
  let overrides: string[] = [];
  try {
    const parsed = new URL(url);
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    overrides = ['database', 'dbname', 'db'].filter((k) => parsed.searchParams.has(k));
  } catch {
    throw new Error(`the database url does not parse; the provisioner only runs against ${allowed}`);
  }
  if (overrides.length) throw new Error(`refusing to provision: the database url carries ${overrides.join(', ')} in its query string; name the database in the path only (${allowed})`);
  if (name !== allowed) {
    throw new Error(`refusing to provision: the database url names "${name || '(none)'}", the provisioner only runs against ${allowed}`);
  }
}

/**
 * The guard that matters: the url's path can be overridden by the driver, so after connecting, the server must say it is
 * `allowed`. Takes anything with a pg-style `query`, so a test can answer for it.
 * @returns the database name
 */
export async function assertConnectedToDev(
  db: { query(sql: string): Promise<{ rows: Array<{ db: string }> }> }, allowed: string = DEV_DATABASE,
): Promise<string> {
  const actual = (await db.query('SELECT current_database() AS db')).rows[0]?.db;
  if (actual !== allowed) throw new Error(`connected to "${actual ?? '(none)'}", not ${allowed}; stopping before any write`);
  return actual;
}

/** Throws unless `url` is the GoTrue instance slot users are created in (EXPECTED_GOTRUE_URL), trailing slash aside. */
export function assertGoTrueUrl(url: string | undefined, expected: string = EXPECTED_GOTRUE_URL): void {
  if ((url ?? '').replace(/\/+$/, '') !== expected) {
    throw new Error(`refusing to create users: GOTRUE_URL is not the expected instance ${expected} (slot users live in the GoTrue shared with production)`);
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

/**
 * A reset slot is a bare clone of Demo's setup data: without the seed the specs that read volume (x-contrast, p-type-money,
 * n-a11y) fail on it, so --reset-slot refuses to run without --seed-url (a dry run seeds nothing, so it is let through).
 */
export function assertResetSeeds(resetSlot: number | undefined, seedUrl: string | undefined, dryRun: boolean): void {
  if (resetSlot !== undefined && !seedUrl && !dryRun) {
    throw new Error(`--reset-slot ${resetSlot} needs --seed-url <local dev server, port 3300-3799>: a rebuilt slot without the GSEED data fails the volume specs`);
  }
}

/** A newly created slot has the same bare-clone seed requirement as a reset slot. */
export function assertFreshSlotSeeds(slot: number, fresh: boolean, seedUrl: string | undefined, dryRun: boolean): void {
  if (fresh && !seedUrl && !dryRun) {
    throw new Error(`new slot ${slot} needs --seed-url <local dev server, port 3300-3799>: a fresh slot without the GSEED data fails the volume specs`);
  }
}
