/**
 * Shared helpers for the IsaDemo2 QA toolchain.
 *
 * Owns: .env.local loader (path-relative, not hardcoded), DB connection
 * resolver, the IsaDemo2 tenant constants, and a public-API CookieJar so
 * the HTTP walkthrough can manipulate cookies without private-field casts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve .env.local relative to THIS file's location, not a hardcoded
// developer path. Works in CI, on any developer machine, in CronCreate
// invocations — anywhere with a normal repo checkout.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(HERE, '..', '.env.local');

export function loadDotenvLocal(): void {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

export function getEnvLocalPath(): string { return ENV_PATH; }

export function appendEnvIfMissing(key: string, value: string): void {
  const lines = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8').split('\n') : [];
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  const newLine = `${key}=${value}`;
  if (idx >= 0) {
    if (lines[idx] === newLine) return;
    lines[idx] = newLine;
  } else {
    lines.push(newLine);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n'));
}

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.MIGRATION_ADMIN_DATABASE_URL;
  if (!url) {
    console.error('ERROR: DATABASE_URL or MIGRATION_ADMIN_DATABASE_URL must be set');
    process.exit(1);
  }
  return url;
}

export const ISADEMO2_ID = '00000000-0000-0000-0000-0000000d4e02';
export const ISADEMO2_NAME = 'IsaDemo2 (QA fixture)';
export const ORIGINAL_DEMO_ID = '00000000-0000-0000-0000-000000000001';

/** Required env var for QA scripts that touch IsaDemo2. */
export function getIsaDemo2CompanyId(): string {
  const id = process.env.COMPANY_ID_ISADEMO2;
  if (!id) {
    console.error('ERROR: COMPANY_ID_ISADEMO2 not set — run provision-isademo2.ts first');
    process.exit(1);
  }
  return id;
}

/**
 * Cookie jar with a real public API. Replaces the brittle
 * `(jar as unknown as { jar: Map }).jar.set(...)` pattern that broke
 * encapsulation just to set ff_onboarding_done.
 */
export class CookieJar {
  private cookies = new Map<string, string>();

  ingest(setCookieHeaders: string[]): void {
    for (const sc of setCookieHeaders) {
      const [pair] = sc.split(';', 1);
      const eq = pair!.indexOf('=');
      if (eq < 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      this.cookies.set(name, value);
    }
  }

  /** Public setter — used to seed cookies the server would not normally issue (e.g. ff_onboarding_done). */
  set(name: string, value: string): void { this.cookies.set(name, value); }

  header(): string {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name: string): string | undefined { return this.cookies.get(name); }
}
