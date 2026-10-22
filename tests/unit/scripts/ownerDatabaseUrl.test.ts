/**
 * scripts/ops/ownerDatabaseUrl.sh (S-07b): the deploy's migrations, parity
 * gate and verify step take the schema owner's URL. Behaviour is run for real
 * through bash. deploy.sh itself cannot run (it deploys production), so its
 * two DB-URL blocks are cut out of the real file and run with sudo and bun
 * stubbed, and the rest of the wiring is pinned as text.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const LIB = join(process.cwd(), 'scripts', 'ops', 'ownerDatabaseUrl.sh');

function run(envText: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', ['-c', `set -e; . "${LIB}"; owner_database_url /fixture/.env.local`],
    { input: envText, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('owner_database_url', () => {
  it('prints OWNER_DATABASE_URL when the env names it, without a warning', () => {
    const r = run('DATABASE_URL=postgresql://isaflow_app:a@h:1/isaflow\nOWNER_DATABASE_URL=postgresql://postgres:o@h:1/isaflow\n');
    expect(r).toEqual({ status: 0, stdout: 'postgresql://postgres:o@h:1/isaflow\n', stderr: '' });
  });

  it('falls back to DATABASE_URL with a loud warning naming the file', () => {
    const r = run('SMTP_HOST=x\nDATABASE_URL=postgresql://postgres:p@h:1/isaflow\n');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('postgresql://postgres:p@h:1/isaflow\n');
    expect(r.stderr).toMatch(/WARNING: OWNER_DATABASE_URL is not set in \/fixture\/\.env\.local - falling back to DATABASE_URL/);
    expect(r.stderr).toMatch(/isaflow_app/);
  });

  it('does not take a commented-out or prefixed variable for the real one', () => {
    const r = run('#OWNER_DATABASE_URL=postgresql://wrong@h/x\nX_OWNER_DATABASE_URL=postgresql://wrong@h/y\nDATABASE_URL=postgresql://right@h/isaflow\n');
    expect(r.stdout).toBe('postgresql://right@h/isaflow\n');
  });

  it('prints nothing and fails when the env names neither', () => {
    expect(run('SMTP_HOST=x\n')).toEqual({ status: 1, stdout: '', stderr: '' });
  });
});

describe('deploy.sh uses the owner URL for every schema-owner step', () => {
  const deploy = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8');
  const code = deploy.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('sources the helper', () => {
    expect(code).toContain('. "$REPO_DIR/scripts/ops/ownerDatabaseUrl.sh"');
  });

  it('reads prod\'s URL through it for the parity gate and for migrations (which verify-deploy reuses)', () => {
    expect(code).toContain('PARITY_PROD_DB=$(sudo cat "$PARITY_PROD_ENV" | owner_database_url "$PARITY_PROD_ENV" || true)');
    expect(code).toContain('PROD_DB=$(sudo cat "$PROD_ENV" | owner_database_url "$PROD_ENV" || true)');
    expect(code).toMatch(/DATABASE_URL="\$PROD_DB" \$BUN "\$REPO_DIR\/scripts\/apply-migrations\.ts"/);
    expect(code).toMatch(/DATABASE_URL="\$PROD_DB" \$BUN "\$REPO_DIR\/scripts\/audit-schema-drift\.ts"/);
    expect(code).toMatch(/DATABASE_URL="\$PROD_DB" bash "\$REPO_DIR\/scripts\/verify-deploy\.sh"/);
  });

  it('applies dev\'s pending migrations with dev\'s owner URL', () => {
    expect(code).toContain('PARITY_DEV_DB=$(owner_database_url "$ENV_LOCAL" < "$ENV_LOCAL" || true)');
    expect(code).toMatch(/DATABASE_URL="\$PARITY_DEV_DB" PARITY_PROD_DATABASE_URL="\$PARITY_PROD_DB" \$BUN "\$REPO_DIR\/scripts\/check-migration-parity\.ts" --apply-dev/);
  });

  it('no longer greps DATABASE_URL straight out of an env file', () => {
    expect(code).not.toMatch(/grep\s+(-\S+\s+)*["']?\^?DATABASE_URL=/);
  });

  it('parses', () => {
    expect(spawnSync('bash', ['-n', join(process.cwd(), 'scripts', 'deploy.sh')]).status).toBe(0);
  });
});

/** deploy.sh's text from the line starting with `from` through the first line starting with `to` after it. */
function deployBlock(from: string, to: string): string {
  const lines = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8').split('\n');
  const a = lines.findIndex((l) => l.trim().startsWith(from));
  const b = lines.findIndex((l, i) => i > a && l.startsWith(to));
  if (a < 0 || b < 0) throw new Error(`deploy.sh has no block ${from} .. ${to}`);
  return lines.slice(a, b + 1).join('\n');
}

describe('deploy.sh\'s DB-URL blocks, run with sudo and bun stubbed', () => {
  const parity = deployBlock('. "$REPO_DIR/scripts/ops/ownerDatabaseUrl.sh"', 'unset PARITY_PROD_DB');
  // deploy.sh sources the helper once, in the parity block, before this one.
  const migrate = `. "$REPO_DIR/scripts/ops/ownerDatabaseUrl.sh"\n${deployBlock('PROD_ENV="$DEPLOY_DIR/.env.local"', 'fi')}`;

  function runBlock(block: string, prodEnv: string, devEnv: string): { status: number | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 's07b-deploy-'));
    try {
      writeFileSync(join(dir, '.env.local'), prodEnv);
      writeFileSync(join(dir, 'dev.env'), devEnv);
      writeFileSync(join(dir, 'bun'), '#!/bin/bash\necho "RAN $(basename "$1") DATABASE_URL=$DATABASE_URL PROD=$PARITY_PROD_DATABASE_URL"\n');
      const script = `set -e\nsudo() { "$@"; }\nREPO_DIR="${process.cwd()}"\nDEPLOY_DIR="${dir}"\nENV_LOCAL="${dir}/dev.env"\nBUN="bash ${dir}/bun"\n${block}\n`;
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      return { status: r.status, out: r.stdout + r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const PROD = 'OWNER_DATABASE_URL=postgresql://postgres@p/isaflow\nDATABASE_URL=postgresql://isaflow_app@p/isaflow\n';
  const DEV = 'OWNER_DATABASE_URL=postgresql://postgres@d/isaflow_dev\nDATABASE_URL=postgresql://isaflow_app@d/isaflow_dev\n';

  it('the parity gate gets both owner URLs', () => {
    const r = runBlock(parity, PROD, DEV);
    expect(r.status).toBe(0);
    expect(r.out).toContain('RAN check-migration-parity.ts DATABASE_URL=postgresql://postgres@d/isaflow_dev PROD=postgresql://postgres@p/isaflow');
  });

  it('the parity gate stops, saying why, when prod\'s env names neither URL', () => {
    const r = runBlock(parity, 'NODE_ENV=production\n', DEV);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/ERROR: cannot read OWNER_DATABASE_URL or DATABASE_URL from .*\.env\.local/);
    expect(r.out).not.toContain('RAN ');
  });

  it('migrations, the drift audit and the login-role check run on prod\'s owner URL, in that order', () => {
    const r = runBlock(migrate, PROD, DEV);
    expect(r.status).toBe(0);
    const ran = r.out.split('\n').filter((l) => l.startsWith('RAN '));
    expect(ran).toEqual(['apply-migrations.ts', 'audit-schema-drift.ts', 'check-app-login-roles.ts']
      .map((f) => `RAN ${f} DATABASE_URL=postgresql://postgres@p/isaflow PROD=`));
  });

  it('a failing login-role check stops the deploy here, before the code switch', () => {
    const r = runBlock(migrate.replace(/\$BUN "\$REPO_DIR\/scripts\/check-app-login-roles\.ts"/, 'false'), PROD, DEV);
    expect(r.status).not.toBe(0);
    expect(migrate).toContain('DATABASE_URL="$PROD_DB" $BUN "$REPO_DIR/scripts/check-app-login-roles.ts"');
  });

  it('migrations fall back to DATABASE_URL, with the warning, before the env names an owner URL', () => {
    const r = runBlock(migrate, 'DATABASE_URL=postgresql://postgres@p/isaflow\n', DEV);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/WARNING: OWNER_DATABASE_URL is not set/);
    expect(r.out).toContain('RAN apply-migrations.ts DATABASE_URL=postgresql://postgres@p/isaflow');
  });
});

describe('load_pg_conn (backups and the restore drill) takes the owner URL too', () => {
  it('is installed with the helper it sources', () => {
    const install = readFileSync(join(process.cwd(), 'scripts', 'ops', 'install-backup-ops.sh'), 'utf8');
    expect(install).toMatch(/install [^\n]*"\$SRC\/ownerDatabaseUrl\.sh"\s+"\$DEST\/ownerDatabaseUrl\.sh"/);
  });

  const PGCONN = join(process.cwd(), 'scripts', 'ops', 'lib-pgconn.sh');
  function load(envText: string): { status: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 's07b-pgconn-'));
    try {
      writeFileSync(join(dir, '.env.local'), envText);
      const r = spawnSync('bash', ['-c', `. "${PGCONN}"; load_pg_conn "${dir}/.env.local" && echo "$PG_URL"`], { encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('connects as OWNER_DATABASE_URL\'s user when set', () => {
    const r = load('DATABASE_URL=postgresql://isaflow_app:a@h:7772/isaflow\nOWNER_DATABASE_URL=postgresql://postgres:o@h:7772/isaflow\n');
    expect(r).toMatchObject({ status: 0, stdout: 'postgresql://postgres@h:7772/isaflow\n', stderr: '' });
  });

  it('falls back to DATABASE_URL with a warning', () => {
    const r = load('DATABASE_URL=postgresql://postgres:p@h:7772/isaflow\n');
    expect(r.stdout).toBe('postgresql://postgres@h:7772/isaflow\n');
    expect(r.stderr).toMatch(/WARNING: OWNER_DATABASE_URL is not set in .*\.env\.local - falling back to DATABASE_URL/);
  });
});
