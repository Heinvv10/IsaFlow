/**
 * The keys the deploy verification reads from the deploy env file (/home/hein/isaflow-deploy.env, 0600), by login: the email
 * and password keys of identity.ts (scripts/verify-deploy.sh reads them). Only those, and a pending-password key while a
 * run is unfinished, are ever created, replaced or removed; every other line stays byte for byte, and values are never
 * printed. The file must be private: one that group or others can read is refused, not written.
 */
import { chmodSync, chownSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { upsertEnvKeys } from '../../ci/golden/slotConfig';
import type { LoginIdentity } from './identity';

export interface Login { email: string; password: string }

/** Keys as verify-deploy.sh reads them: from column 0, the last line of a key wins, a trailing CR is not part of the value. */
export function parseEnvKeys(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.replace(/\r$/, ''));
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function read(path: string): Record<string, string> {
  return existsSync(path) ? parseEnvKeys(readFileSync(path, 'utf8')) : {};
}

/** The login the file holds for `who`, or null when either key is missing or empty. */
export function readLogin(path: string, who: LoginIdentity): Login | null {
  const env = read(path);
  const email = env[who.emailKey] ?? '';
  const password = env[who.passwordKey] ?? '';
  return email && password ? { email, password } : null;
}

/** The password a run saved right after creating `who`'s GoTrue login and before provisioning finished, or null. */
export function readPending(path: string, who: LoginIdentity): string | null {
  return read(path)[who.pendingKey] || null;
}

/** Drops every line of `keys` after its first, so the one upsertEnvKeys replaces is the one verify-deploy.sh would read. */
function withoutRepeats(text: string, keys: string[]): string {
  const seen = new Set<string>();
  return text.split('\n').filter((line) => {
    const key = keys.find((k) => line.replace(/\r$/, '').startsWith(`${k}=`));
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join('\n');
}

function withoutKeys(text: string, keys: string[]): string {
  return text.split('\n').filter((line) => !keys.some((k) => line.startsWith(`${k}=`))).join('\n');
}

/**
 * The text replaces the file through a temp file made with flag 'wx' (never an existing path), mode 0600, then renamed:
 * a reader never sees half a file. The file's own owner and group are kept where chown is allowed.
 */
function writeAtomic(path: string, text: string): void {
  const { mode, uid, gid } = statSync(path);
  if (mode & 0o077) throw new Error(`${path} is readable or writable by group or others (mode ${(mode & 0o777).toString(8)}); it holds passwords: chmod 600 it first`);
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(temp, mode & 0o777);
    try { chownSync(temp, uid, gid); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err; }
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Applies `change` to the file's text (an absent file is created 0600). @returns whether the file changed. */
function update(path: string, change: (before: string) => string): boolean {
  if (!existsSync(path)) {
    const text = change('');
    writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    return true;
  }
  const before = readFileSync(path, 'utf8');
  const after = change(before);
  if (after === before) return false;
  writeAtomic(path, after);
  return true;
}

/** Saves `who`'s new password under its pending key, so a run that dies before it finishes can be re-run plainly. */
export function writePending(path: string, who: LoginIdentity, password: string): boolean {
  return update(path, (before) => upsertEnvKeys(before, { [who.pendingKey]: password }));
}

/**
 * Writes every login's two keys and drops their pending keys, in one replacement of the file. A file that already holds
 * exactly these values is not written at all.
 * @returns whether the file changed
 */
export function writeLogins(path: string, logins: Array<{ who: LoginIdentity; login: Login }>): boolean {
  const entries: Record<string, string> = {};
  for (const { who, login } of logins) {
    entries[who.emailKey] = login.email;
    entries[who.passwordKey] = login.password;
  }
  const pending = logins.map(({ who }) => who.pendingKey);
  return update(path, (before) => upsertEnvKeys(withoutKeys(withoutRepeats(before, Object.keys(entries)), pending), entries));
}
