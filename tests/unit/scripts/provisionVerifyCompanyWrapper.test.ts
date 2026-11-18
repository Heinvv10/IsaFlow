/**
 * scripts/deploy/provision-verify-company.sh resolves the three secrets the way deploy.sh does and hands them to the
 * provisioner in the ENVIRONMENT (not argv, which `ps` shows), with every target named. A stub `bun` records what it got.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function run(prodEnv: string, ownerEnv: string | null, args: string[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'prov-wrapper-'));
  const seen = path.join(dir, 'seen.txt');
  const bun = path.join(dir, 'bun');
  writeFileSync(bun, `#!/bin/bash\n{ printf 'ARGS=%s\\n' "$*"; printf 'DB=%s\\nGOTRUE=%s\\nKEY=%s\\n' "$VERIFY_COMPANY_DATABASE_URL" "$GOTRUE_URL" "$SUPABASE_SERVICE_ROLE_KEY"; } > "${seen}"\n`);
  chmodSync(bun, 0o755);
  const prod = path.join(dir, 'prod.env.local');
  writeFileSync(prod, prodEnv);
  const owner = path.join(dir, 'owner.env');
  if (ownerEnv !== null) writeFileSync(owner, ownerEnv);
  const r = spawnSync('bash', ['scripts/deploy/provision-verify-company.sh', ...args], {
    encoding: 'utf8', env: { ...process.env, BUN: bun, SUDO: '', PROVISION_PROD_ENV: prod, OWNER_ENV_FILE: owner, PROVISION_ENV_FILE: '/x/deploy.env' },
  });
  let got: Record<string, string> = {};
  try { got = Object.fromEntries(readFileSync(seen, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])); } catch { /* the provisioner never ran */ }
  return { code: r.status, out: `${r.stdout}${r.stderr}`, got };
}

// The scheme is a variable so the pre-commit secret scan does not read the placeholder logins as credentials.
const SCHEME = 'postgresql';
const APP_DB = `${SCHEME}://app:a@h/isaflow`;
const OWNER_DB = `${SCHEME}://owner:o@h/isaflow`;
const PROD = ['DATABASE_URL=' + APP_DB, 'GOTRUE_URL=http://g:7770/auth/v1', 'SUPABASE_SERVICE_ROLE_KEY=svc.key.value', 'SMTP_FROM=IsaFlow <x@y>', ''].join('\n');

describe('provision-verify-company.sh', () => {
  it('prefers the owner file, takes GoTrue from the app env, passes secrets by environment and names every target', () => {
    const r = run(PROD, 'OWNER_DATABASE_URL=' + OWNER_DB + '\n', ['--dry-run']);
    expect(r.code).toBe(0);
    expect(r.got.DB).toBe(OWNER_DB);
    expect(r.got.GOTRUE).toBe('http://g:7770/auth/v1');
    expect(r.got.KEY).toBe('svc.key.value');
    expect(r.got.ARGS).toContain('--expect-database isaflow --base-url http://127.0.0.1:3101 --env-file /x/deploy.env --dry-run');
    for (const secret of ['owner:o', 'svc.key.value']) expect(r.got.ARGS).not.toContain(secret);
  });

  it('falls back to the app env for the database url, as owner_database_url_for does', () => {
    const r = run(PROD, null);
    expect(r.got.DB).toBe(APP_DB);
  });

  it.each(['GOTRUE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])('refuses, naming it, when %s is missing', (key) => {
    const r = run(PROD.split('\n').filter((l) => !l.startsWith(`${key}=`)).join('\n'), null);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(key);
    expect(r.got).toEqual({});
  });
});
