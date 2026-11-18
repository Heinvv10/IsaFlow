/**
 * The two keys the deploy verification reads from the deploy env file (/home/hein/isaflow-deploy.env, 0600):
 * E2E_VERIFY_EMAIL and E2E_VERIFY_PASSWORD (scripts/verify-deploy.sh). Only these two are ever created or replaced; every
 * other line stays byte for byte, and the values are never printed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnvFile, upsertEnvKeys } from '../../ci/golden/slotConfig';
import { writeEnvFileAtomic } from '../../ci/golden/slotEnvFile';

export const VERIFY_EMAIL_KEY = 'E2E_VERIFY_EMAIL';
export const VERIFY_PASSWORD_KEY = 'E2E_VERIFY_PASSWORD';

export interface VerifyLogin { email: string; password: string }

/** The login the file holds (the last line of a key wins, as verify-deploy.sh reads it), or null when either key is missing or empty. */
export function readVerifyLogin(path: string): VerifyLogin | null {
  if (!existsSync(path)) return null;
  const env = parseEnvFile(readFileSync(path, 'utf8'));
  const email = env[VERIFY_EMAIL_KEY] ?? '';
  const password = env[VERIFY_PASSWORD_KEY] ?? '';
  return email && password ? { email, password } : null;
}

/** Drops every line of `keys` after its first, so the one upsertEnvKeys replaces is the one verify-deploy.sh would read. */
function withoutRepeats(text: string, keys: string[]): string {
  const seen = new Set<string>();
  const kept = text.split('\n').filter((line) => {
    const key = keys.find((k) => line.startsWith(`${k}=`));
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return kept.join('\n');
}

/**
 * Creates the file (mode 0600) or replaces the two keys in it, keeping its mode, owner and every other line. A file
 * that already holds exactly these values is not written at all.
 * @returns whether the file changed
 */
export function writeVerifyLogin(path: string, login: VerifyLogin): boolean {
  const entries = { [VERIFY_EMAIL_KEY]: login.email, [VERIFY_PASSWORD_KEY]: login.password };
  if (!existsSync(path)) {
    writeFileSync(path, upsertEnvKeys('', entries), { mode: 0o600, flag: 'wx' });
    return true;
  }
  const before = readFileSync(path, 'utf8');
  const after = upsertEnvKeys(withoutRepeats(before, Object.keys(entries)), entries);
  if (after === before) return false;
  writeEnvFileAtomic(path, after);
  return true;
}
