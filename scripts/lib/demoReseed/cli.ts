/**
 * The CLI contract, pure (PLAN 2.1): `--company` is required and must be the
 * Demo id; `--dry-run` and `--check-only` exclude each other; the database URL
 * comes only from DEMO_RESEED_DATABASE_URL and is described without its password.
 */

import { DB_URL_ENV, DEFAULT_SEED, DEMO_COMPANY_ID } from './constants';
import { assertIsoDay } from './dates';

export type Mode = 'run' | 'dry-run' | 'check-only';

export interface CliArgs {
  companyId: string;
  mode: Mode;
  today?: string;
  seed: number;
}

/** A refusal before any write: the CLI exits 2. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
  }
}

export function assertDemoCompany(id: string | undefined): string {
  if (!id) throw new Refusal('refusing to run without --company');
  if (id.toLowerCase() !== DEMO_COMPANY_ID) throw new Refusal(`refusing company ${id}: only the Demo company may be reseeded`);
  return DEMO_COMPANY_ID;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let company: string | undefined;
  let today: string | undefined;
  let seed = DEFAULT_SEED;
  const modes: Mode[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Refusal(`${a} needs a value`);
      return v;
    };
    if (a === '--company') company = value();
    else if (a.startsWith('--company=')) company = a.slice('--company='.length);
    else if (a === '--dry-run') modes.push('dry-run');
    else if (a === '--check-only') modes.push('check-only');
    else if (a === '--today') today = value();
    else if (a === '--seed') seed = Number(value());
    else throw new Refusal(`unknown argument ${a}`);
  }
  if (modes.length > 1) throw new Refusal('--dry-run and --check-only exclude each other');
  if (today !== undefined) {
    try { assertIsoDay(today); } catch { throw new Refusal(`--today ${today} is not a calendar day (YYYY-MM-DD)`); }
  }
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Refusal('--seed must be a non-negative integer');
  return { companyId: assertDemoCompany(company), mode: modes[0] ?? 'run', ...(today ? { today } : {}), seed };
}

export function resolveDbUrl(env: Readonly<Record<string, string | undefined>>): string {
  const url = env[DB_URL_ENV];
  if (!url) throw new Refusal(`${DB_URL_ENV} is not set: the reseed reads its database URL from that variable only`);
  return url;
}

/** host, port, database and user of a URL; never the password. */
export function describeTarget(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new Refusal(`${DB_URL_ENV} is not a valid URL`); }
  const db = decodeURIComponent(u.pathname.replace(/^\//, '')) || '(default)';
  return `host=${u.hostname} port=${u.port || '5432'} database=${db} user=${decodeURIComponent(u.username) || '(default)'}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * TLS: the URL's own sslmode decides (pg verifies the server certificate for require/verify-*).
 * A host that is not loopback must ask for TLS: no sslmode, or sslmode=disable, is refused.
 */
export function assertTransportSafe(url: string): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new Refusal(`${DB_URL_ENV} is not a valid URL`); }
  const mode = u.searchParams.get('sslmode');
  if (!LOOPBACK.has(u.hostname) && (mode === null || mode === 'disable' || mode === 'allow' || mode === 'prefer' || mode === 'no-verify')) {
    throw new Refusal(`host ${u.hostname} is not loopback: add sslmode=verify-full (or require) to ${DB_URL_ENV}; plaintext or unverified TLS is refused`);
  }
}

/** A supplied --today later than the database's own date is refused. */
export function assertTodayNotFuture(today: string, dbToday: string): void {
  if (today > dbToday) throw new Refusal(`--today ${today} is after the database's date ${dbToday}`);
}

/** For the legacy Demo seeders: the `--company` argument, or exit 2 with the refusal (no env override). */
export function demoCompanyOrExit(argv: readonly string[]): string {
  const i = argv.findIndex((a) => a === '--company' || a.startsWith('--company='));
  const value = i < 0 ? undefined : argv[i]!.startsWith('--company=') ? argv[i]!.slice('--company='.length) : argv[i + 1];
  try {
    return assertDemoCompany(value);
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    process.stderr.write(`REFUSED: ${err.message}\n`);
    return process.exit(2);
  }
}
