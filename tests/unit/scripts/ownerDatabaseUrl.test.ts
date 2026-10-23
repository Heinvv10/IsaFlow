/**
 * scripts/ops/ownerDatabaseUrl.sh (S-07b): the deploy's migrations, parity
 * gate and verify step take the schema owner's URL. Behaviour is run for real
 * through bash. deploy.sh itself cannot run (it deploys production), so its
 * two DB-URL blocks are cut out of the real file and run with sudo and bun
 * stubbed, and the rest of the wiring is pinned as text.
 *
 * S-07b follow-up F: production keeps the owner URL in a root-only file
 * outside the deploy directory (OWNER_ENV_FILE, default /etc/isaflow/owner.env),
 * which the app process cannot read. Each prod reader takes it first, then the
 * app env's OWNER_DATABASE_URL (with a warning to move it), then DATABASE_URL.
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

const OWNER_LINE = 'OWNER_DATABASE_URL=postgresql://postgres:f@h:1/isaflow\n';
const APP_ENV_OWNER = 'DATABASE_URL=postgresql://isaflow_app:a@h:1/isaflow\nOWNER_DATABASE_URL=postgresql://postgres:e@h:1/isaflow\n';
const APP_ENV_PLAIN = 'DATABASE_URL=postgresql://postgres:p@h:1/isaflow\n';

/** Files in a fresh directory: `owner` (when given) and `.env.local`; the result of `body` run in bash. */
function withFiles(owner: string | null, envText: string, body: (dir: string) => string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 's07b-owner-'));
  try {
    if (owner !== null) writeFileSync(join(dir, 'owner.env'), owner);
    writeFileSync(join(dir, '.env.local'), envText);
    const r = spawnSync('bash', ['-c', body(dir)], { encoding: 'utf8', env: { ...process.env, OWNER_ENV_FILE: join(dir, 'owner.env') } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const forEnv = (owner: string | null, envText: string) =>
  withFiles(owner, envText, (dir) => `set -e; . "${LIB}"; owner_database_url_for "${dir}/.env.local"`);

describe('owner_database_url_for: the owner file, then the app env, then DATABASE_URL', () => {
  it('defaults to a root-only path outside the deploy directory that rsync --delete replaces', () => {
    const r = spawnSync('bash', ['-c', `env -u OWNER_ENV_FILE bash -c '. "${LIB}"; echo "$OWNER_ENV_FILE"'`], { encoding: 'utf8' });
    expect(r.stdout).toBe('/etc/isaflow/owner.env\n');
  });

  it('takes the owner file\'s OWNER_DATABASE_URL first, silently', () => {
    expect(forEnv(OWNER_LINE, APP_ENV_OWNER)).toEqual({ status: 0, stdout: 'postgresql://postgres:f@h:1/isaflow\n', stderr: '' });
  });

  it('then the app env\'s OWNER_DATABASE_URL, warning that the app process loads it', () => {
    const r = forEnv(null, APP_ENV_OWNER);
    expect(r.stdout).toBe('postgresql://postgres:e@h:1/isaflow\n');
    expect(r.stderr).toMatch(/WARNING: OWNER_DATABASE_URL is read from .*\.env\.local, which the app process loads; move it to .*owner\.env/);
  });

  it.each([
    ['only commented out, or other variables', '#OWNER_DATABASE_URL=postgresql://wrong@h/x\nDATABASE_URL=postgresql://wrong@h/y\n'],
    ['an empty value', 'OWNER_DATABASE_URL=\n'],
  ])('an owner file holding %s counts as absent, with a warning naming it', (_, owner) => {
    const r = forEnv(owner, APP_ENV_OWNER);
    expect(r.stdout).toBe('postgresql://postgres:e@h:1/isaflow\n');
    expect(r.stderr).toMatch(/WARNING: .*owner\.env exists but gave no OWNER_DATABASE_URL/);
  });

  it('a missing owner file falls back without that warning', () => {
    expect(forEnv(null, APP_ENV_OWNER).stderr).not.toMatch(/exists but gave no/);
  });

  it('then DATABASE_URL, with the not-set warning', () => {
    const r = forEnv(null, APP_ENV_PLAIN);
    expect(r.stdout).toBe('postgresql://postgres:p@h:1/isaflow\n');
    expect(r.stderr).toMatch(/WARNING: OWNER_DATABASE_URL is not set in .*\.env\.local - falling back to DATABASE_URL/);
  });

  it('prints nothing and fails when none of the three is there', () => {
    expect(forEnv(null, 'SMTP_HOST=x\n')).toMatchObject({ status: 1, stdout: '' });
  });

  it('reads both files through the given prefix (deploy.sh passes sudo)', () => {
    const r = withFiles(OWNER_LINE, APP_ENV_PLAIN, (dir) =>
      `set -e; . "${LIB}"; via() { echo "VIA $*" >> "${dir}/via.log"; "$@"; }; owner_database_url_for "${dir}/.env.local" via; cat "${dir}/via.log" >&2`);
    expect(r.stdout).toBe('postgresql://postgres:f@h:1/isaflow\n');
    expect(r.stderr).toMatch(/^VIA cat .*owner\.env$/m);
  });
});

describe('deploy.sh uses the owner URL for every schema-owner step', () => {
  const deploy = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8');
  const code = deploy.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  it('sources the helper', () => {
    expect(code).toContain('. "$REPO_DIR/scripts/ops/ownerDatabaseUrl.sh"');
  });

  it('reads prod\'s URL through it for the parity gate and for migrations (which verify-deploy reuses)', () => {
    expect(code).toContain('PARITY_PROD_DB=$(owner_database_url_for "$PARITY_PROD_ENV" sudo || true)');
    expect(code).toContain('PROD_DB=$(owner_database_url_for "$PROD_ENV" sudo || true)');
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

  function runBlock(block: string, prodEnv: string, devEnv: string, ownerFile: string | null = null): { status: number | null; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 's07b-deploy-'));
    try {
      writeFileSync(join(dir, '.env.local'), prodEnv);
      if (ownerFile !== null) writeFileSync(join(dir, 'owner.env'), ownerFile);
      writeFileSync(join(dir, 'dev.env'), devEnv);
      writeFileSync(join(dir, 'bun'), '#!/bin/bash\necho "RAN $(basename "$1") DATABASE_URL=$DATABASE_URL PROD=$PARITY_PROD_DATABASE_URL"\n');
      const script = `set -e\nsudo() { "$@"; }\nREPO_DIR="${process.cwd()}"\nDEPLOY_DIR="${dir}"\nENV_LOCAL="${dir}/dev.env"\nBUN="bash ${dir}/bun"\n${block}\n`;
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, OWNER_ENV_FILE: join(dir, 'owner.env') } });
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

  it('the parity gate and the migrations take the owner file first, over the app env', () => {
    const owner = 'OWNER_DATABASE_URL=postgresql://postgres@file/isaflow\n';
    expect(runBlock(parity, PROD, DEV, owner).out)
      .toContain('RAN check-migration-parity.ts DATABASE_URL=postgresql://postgres@d/isaflow_dev PROD=postgresql://postgres@file/isaflow');
    const ran = runBlock(migrate, PROD, DEV, owner).out.split('\n').filter((l) => l.startsWith('RAN '));
    expect(ran).toEqual(['apply-migrations.ts', 'audit-schema-drift.ts', 'check-app-login-roles.ts']
      .map((f) => `RAN ${f} DATABASE_URL=postgresql://postgres@file/isaflow PROD=`));
  });

  it('without the owner file, they use the app env\'s OWNER_DATABASE_URL and warn to move it', () => {
    for (const block of [parity, migrate]) {
      const r = runBlock(block, PROD, DEV);
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/WARNING: OWNER_DATABASE_URL is read from .*\.env\.local, which the app process loads/);
      expect(r.out).toMatch(/RAN \S+ DATABASE_URL=postgresql:\/\/postgres@[dp]\/isaflow/);
    }
  });

  it('the parity gate falls back to prod\'s DATABASE_URL, with the warning, when neither owner URL is there', () => {
    const r = runBlock(parity, 'DATABASE_URL=postgresql://postgres@p/isaflow\n', DEV);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/WARNING: OWNER_DATABASE_URL is not set/);
    expect(r.out).toContain('PROD=postgresql://postgres@p/isaflow');
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
  const load = (envText: string, owner: string | null = null) =>
    withFiles(owner, envText, (dir) => `. "${PGCONN}"; load_pg_conn "${dir}/.env.local" && echo "$PG_URL"`);

  it('connects as the owner file\'s user first', () => {
    const r = load('DATABASE_URL=postgresql://isaflow_app:a@h:7772/isaflow\nOWNER_DATABASE_URL=postgresql://other:o@h:7772/isaflow\n',
      'OWNER_DATABASE_URL=postgresql://postgres:o@h:7772/isaflow\n');
    expect(r).toMatchObject({ status: 0, stdout: 'postgresql://postgres@h:7772/isaflow\n', stderr: '' });
  });

  it('then the app env\'s OWNER_DATABASE_URL, with the move-it warning', () => {
    const r = load('DATABASE_URL=postgresql://isaflow_app:a@h:7772/isaflow\nOWNER_DATABASE_URL=postgresql://postgres:o@h:7772/isaflow\n');
    expect(r).toMatchObject({ status: 0, stdout: 'postgresql://postgres@h:7772/isaflow\n' });
    expect(r.stderr).toMatch(/which the app process loads/);
  });

  it('falls back to DATABASE_URL with a warning', () => {
    const r = load('DATABASE_URL=postgresql://postgres:p@h:7772/isaflow\n');
    expect(r.stdout).toBe('postgresql://postgres@h:7772/isaflow\n');
    expect(r.stderr).toMatch(/WARNING: OWNER_DATABASE_URL is not set in .*\.env\.local - falling back to DATABASE_URL/);
  });
});
