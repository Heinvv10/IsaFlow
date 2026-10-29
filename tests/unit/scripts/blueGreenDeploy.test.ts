/**
 * Blue/green deploy helpers (scripts/deploy/bluegreen.sh), run for real in bash against a scratch folder with stub
 * nginx/systemctl/date on PATH, plus the order of deploy.sh's steps (a text check: running deploy.sh would deploy
 * production).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const LIB = join(process.cwd(), 'scripts', 'deploy', 'bluegreen.sh');
let root: string;

const stub = (name: string, body: string) => {
  const p = join(root, 'bin', name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
};
/** Runs `script` after sourcing the library; returns stdout, or throws with the exit status. */
const run = (script: string, env: Record<string, string> = {}) => execFileSync('bash', ['-c', `set -e\n. "${LIB}"\n${script}`], {
  encoding: 'utf8',
  env: {
    PATH: `${join(root, 'bin')}:${process.env.PATH}`, BG_SUDO: '', BG_OWNER: `${process.getuid!()}`,
    BG_RELEASE_ROOT: join(root, 'rel'), BG_STATIC_ROOT: join(root, 'static'), BG_ENV_HOME: join(root, 'envhome'),
    BG_UPSTREAM_FILE: join(root, 'conf.d', 'isaflow-live.conf'), BG_KEEP_BUILDS: '2', ...env,
  },
});
const upstream = (port: number) => writeFileSync(join(root, 'conf.d', 'isaflow-live.conf'),
  `upstream isaflow_live {\n    server 127.0.0.1:${port};\n}\n`);
/** A fake built repo whose .next/static holds `files` under build id `id`. */
const build = (id: string, files: string[]) => {
  const repo = join(root, `repo-${id}`);
  mkdirSync(join(repo, '.next/static'), { recursive: true });
  for (const f of files) { mkdirSync(join(repo, '.next/static', f, '..'), { recursive: true }); writeFileSync(join(repo, '.next/static', f), f); }
  mkdirSync(join(repo, '.next/standalone'), { recursive: true });
  writeFileSync(join(repo, '.next/standalone/server.js'), `// ${id}`);
  mkdirSync(join(repo, 'public'), { recursive: true });
  writeFileSync(join(repo, 'public/sw.js'), 'const V = "__BUILD_ID__";');
  writeFileSync(join(repo, '.next/BUILD_ID'), id);
  return repo;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bluegreen-'));
  for (const d of ['bin', 'conf.d', 'envhome']) mkdirSync(join(root, d));
  stub('nginx', `echo "nginx $*" >> "${root}/calls"; [ "$1" = "-t" ] && exit "\${NGINX_T_RC:-0}"; exit 0`);
  stub('systemctl', `echo "systemctl $*" >> "${root}/calls"`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('bg_live_port / bg_other_port', () => {
  it('reads the live port from the upstream file, and names the other colour', () => {
    upstream(3112);
    expect(run('echo "$(bg_live_port) $(bg_other_port "$(bg_live_port)")"').trim()).toBe('3112 3111');
  });

  it('is empty with no upstream file (not cut over) or a port that is not a colour', () => {
    expect(run('echo "[$(bg_live_port)]"').trim()).toBe('[]');
    upstream(3101);
    expect(run('echo "[$(bg_live_port)]"').trim()).toBe('[]');
  });
});

describe('bg_sync_release', () => {
  it('copies the build into the idle colour with its SHA and BUILD_ID, and refuses the live colour\'s folder', () => {
    upstream(3111);
    const repo = build('B1', ['chunks/a.js']);
    run(`bg_sync_release "${repo}" 3112 abc123`);
    const dir = join(root, 'rel', 'isaflow-3112');
    expect({
      server: readFileSync(join(dir, 'server.js'), 'utf8'), sha: readFileSync(join(dir, 'RELEASE_SHA'), 'utf8').trim(),
      sw: readFileSync(join(dir, 'public/sw.js'), 'utf8'), chunk: existsSync(join(dir, '.next/static/chunks/a.js')),
    }).toEqual({ server: '// B1', sha: 'abc123', sw: 'const V = "B1";', chunk: true });
    expect(() => run(`bg_sync_release "${repo}" 3111 abc123`)).toThrow(/refusing to write the LIVE colour/);
    expect(existsSync(join(root, 'rel', 'isaflow-3111'))).toBe(false);
  });
});

describe('bg_sync_static', () => {
  const served = (f: string) => existsSync(join(root, 'static', '_next/static', f));

  it('keeps every file of the last BG_KEEP_BUILDS builds and removes only files no kept build has', () => {
    run(`bg_sync_static "${build('B1', ['chunks/old.js', 'chunks/shared.js'])}"`);
    run(`bg_sync_static "${build('B2', ['chunks/two.js', 'chunks/shared.js'])}"`);
    expect([served('chunks/old.js'), served('chunks/two.js'), served('chunks/shared.js')]).toEqual([true, true, true]);
    run(`sleep 1; bg_sync_static "${build('B3', ['chunks/three.js', 'chunks/shared.js'])}"`);
    expect({
      old: served('chunks/old.js'), two: served('chunks/two.js'), three: served('chunks/three.js'), shared: served('chunks/shared.js'),
      lists: run(`ls "${join(root, 'static', '.builds')}"`).trim().split('\n').sort(),
    }).toEqual({ old: false, two: true, three: true, shared: true, lists: ['B2.list', 'B3.list'] });
  });

  it('a build with no static files prunes nothing (empty keep-set fails closed)', () => {
    run(`bg_sync_static "${build('B1', ['chunks/a.js'])}"`);
    const empty = build('B0', []);
    expect(() => run(`BG_KEEP_BUILDS=1 bg_sync_static "${empty}"`)).toThrow(/keep-set is empty/);
    expect(served('chunks/a.js')).toBe(true);
  });
});

describe('bg_switch', () => {
  it('writes the upstream, validates, reloads', () => {
    upstream(3111);
    run('bg_switch 3112');
    expect({ live: run('bg_live_port').trim(), calls: readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') })
      .toEqual({ live: '3112', calls: ['nginx -t', 'nginx -s reload'] });
  });

  it('a config nginx rejects is rolled back and nginx is not reloaded', () => {
    upstream(3111);
    expect(() => run('bg_switch 3112', { NGINX_T_RC: '1' })).toThrow(/previous upstream restored/);
    expect({ live: run('bg_live_port').trim(), calls: readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') })
      .toEqual({ live: '3111', calls: ['nginx -t'] });
  });
});

describe('bg_start', () => {
  it('refuses to restart the live colour', () => {
    upstream(3111);
    expect(() => run('bg_start 3111')).toThrow(/refusing to restart the LIVE colour/);
    expect(existsSync(join(root, 'calls'))).toBe(false);
  });
});

describe('bg_business_hours (Johannesburg)', () => {
  const at = (dow: string, hour: string) => {
    stub('date', `case "$1" in +%u) echo ${dow};; +%H) echo ${hour};; esac`);
    return run('bg_business_hours && echo yes || echo no').trim();
  };
  it('weekdays 08:00-16:59 only', () => {
    expect([at('1', '07'), at('1', '08'), at('5', '16'), at('5', '17'), at('6', '10'), at('3', '09')])
      .toEqual(['no', 'yes', 'yes', 'no', 'no', 'yes']);
  });
});

describe('deploy.sh order', () => {
  const lines = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8').split('\n');
  const idx = (re: RegExp) => lines.findIndex((l) => !l.trim().startsWith('#') && re.test(l));

  it('refuses an un-cut-over box, then a mid-day migration, before applying migrations', () => {
    const noLive = idx(/run scripts\/deploy\/cutover\.sh once first/);
    const hours = idx(/if bg_business_hours; then/);
    const apply = idx(/^\s*DATABASE_URL="\$PROD_DB" \$BUN "\$REPO_DIR\/scripts\/apply-migrations\.ts"$/);
    expect([noLive, hours, apply].every((i) => i > -1)).toBe(true);
    expect(noLive).toBeLessThan(hours);
    expect(hours).toBeLessThan(apply);
    expect(lines[idx(/PENDING=\$\(/)]).toContain('--dry-run');
  });

  it('starts the idle colour, verifies it on its own port, and only then switches nginx', () => {
    const start = idx(/^bg_start "\$IDLE_PORT"/);
    const verify = idx(/verify-deploy\.sh" "http:\/\/localhost:\$IDLE_PORT"/);
    const sw = idx(/^bg_switch "\$IDLE_PORT"/);
    expect([start, verify, sw].every((i) => i > -1)).toBe(true);
    expect(start).toBeLessThan(verify);
    expect(verify).toBeLessThan(sw);
  });

  it('never restarts or writes the live colour', () => {
    const text = lines.filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(text).not.toMatch(/systemctl (restart|stop) "?\$\{?SERVICE_NAME\}?"?\s*$/m);
    expect(text).not.toMatch(/systemctl (restart|stop|disable)[^\n]*\$LIVE_PORT/);
    expect(text).not.toMatch(/bg_sync_release [^\n]*\$LIVE_PORT/);
    expect(text).not.toMatch(/rsync[^\n]*"\$DEPLOY_DIR\/"/);
  });
});
