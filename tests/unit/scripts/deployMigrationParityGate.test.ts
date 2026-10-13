/**
 * TEXT check, not behaviour: reads scripts/deploy.sh as a string and pins the
 * ORDER of its steps. Running deploy.sh would deploy to production, so the
 * wiring is the only part of the gate that can be checked statically. The
 * parity logic itself is unit-tested in migrationParity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const deploy = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8');
const lines = deploy.split('\n');
const idx = (re: RegExp): number => lines.findIndex((l) => !l.trim().startsWith('#') && re.test(l));

describe('deploy.sh migration-parity gate', () => {
  const gate = idx(/check-migration-parity\.ts/);
  const ci = idx(/\$BUN run ci\b/);
  const skipCi = idx(/SKIP_CI/);
  const build = idx(/\$BUN run build/);

  it('invokes the parity gate with --apply-dev', () => {
    expect(gate).toBeGreaterThan(-1);
    expect(lines[gate]).toContain('--apply-dev');
  });

  it('runs before the CI gate, before SKIP_CI is consulted, and before the build', () => {
    expect(gate).toBeGreaterThan(-1);
    expect(ci).toBeGreaterThan(-1);
    expect(skipCi).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(skipCi);
    expect(gate).toBeLessThan(ci);
    expect(gate).toBeLessThan(build);
  });

  it('is not conditional on SKIP_CI and is not allowed to fail open', () => {
    expect(lines[gate]).not.toMatch(/\|\|\s*(true|:)/);
    const context = lines.slice(Math.max(0, gate - 6), gate + 1).join('\n');
    expect(context).not.toContain('SKIP_CI');
  });

  it('hands the gate the prod URL via env, never on the command line', () => {
    expect(lines[gate]).toMatch(/PARITY_PROD_DATABASE_URL="\$PARITY_PROD_DB"/);
  });
});

describe('deploy.sh protected production environment', () => {
  it('checks the protected env file through sudo', () => {
    expect(deploy).toContain('if ! sudo test -f "$DEPLOY_DIR/.env.local"; then');
    expect(deploy).not.toContain('if [ ! -f "$DEPLOY_DIR/.env.local" ]; then');
  });

  it('installs a missing env file with production ownership and permissions', () => {
    expect(deploy).toContain(
      'sudo install -o velo -g velo -m 600 "$ENV_LOCAL" "$DEPLOY_DIR/.env.local"'
    );
    expect(deploy).not.toContain('sudo -u velo cp "$ENV_LOCAL" "$DEPLOY_DIR/.env.local"');
  });
});
