/**
 * Blue/green deploy (scripts/deploy/bluegreen.sh, rollback-deploy.sh, restart-colours.sh), run for real in bash against
 * a scratch folder: stub nginx/systemctl/date/bun on PATH, and small node HTTP servers standing in for the colours and
 * for nginx's front. deploy.sh itself is checked as text (running it would deploy production).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const LIB = join(process.cwd(), 'scripts', 'deploy', 'bluegreen.sh');
let root: string;
let servers: ChildProcess[] = [];

const stub = (name: string, body: string) => {
  const p = join(root, 'bin', name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
};
const baseEnv = (): Record<string, string> => ({
  PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: root, BG_SUDO: '', BG_OWNER: `${process.getuid!()}`,
  BG_RELEASE_ROOT: join(root, 'rel'), BG_STATIC_ROOT: join(root, 'static'), BG_ENV_HOME: join(root, 'envhome'),
  BG_UPSTREAM_FILE: join(root, 'conf.d', 'isaflow-live.conf'), BG_LOCK_FILE: join(root, 'deploy.lock'),
  BG_UNIT_FILE: join(root, 'isaflow@.service'), BG_KEEP_BUILDS: '2', BG_HEALTH_TRIES: '2', BG_DRAIN_SECS: '1', BG_BUN: join(root, 'bin', 'bun'),
});
/** Runs a bash command with stderr folded into stdout; returns the output, or throws an Error whose message is it. */
const bash = (cmd: string, env: Record<string, string>) => {
  try {
    return execFileSync('bash', ['-c', `{ ${cmd}\n} 2>&1`], { encoding: 'utf8', cwd: process.cwd(), env: { ...baseEnv(), ...env } });
  } catch (e) {
    throw new Error(String((e as { stdout?: string }).stdout ?? e));
  }
};
/** Runs `script` under set -e after sourcing the library. */
const run = (script: string, env: Record<string, string> = {}) => bash(`set -e\n. "${LIB}"\n${script}`, env);
const upstream = (port: number | string) => writeFileSync(join(root, 'conf.d', 'isaflow-live.conf'),
  `upstream isaflow_live {\n    server 127.0.0.1:${port};\n}\n`);
const calls = () => (existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') : []);
const release = (port: number | string, sha: string, failed = false) => {
  const dir = join(root, 'rel', `isaflow-${port}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'server.js'), '//');
  writeFileSync(join(dir, 'RELEASE_SHA'), `${sha}\n`);
  if (failed) writeFileSync(join(dir, 'FAILED'), 'abc: VERIFICATION FAILED\n');
};
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
/** An HTTP server answering 200 on every path; `upstreamHeader` mimics nginx's X-IsaFlow-Upstream. Resolves its port. */
const serve = (upstreamHeader = ''): Promise<number> => new Promise((resolve) => {
  const child = spawn(process.execPath, ['-e', `require('http').createServer((q, s) => {
      ${upstreamHeader ? `s.setHeader('x-isaflow-upstream', ${JSON.stringify(upstreamHeader)});` : ''}
      s.end('{"status":"ok"}'); }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`]);
  servers.push(child);
  child.stdout!.once('data', (d) => resolve(Number(String(d).trim())));
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bluegreen-'));
  for (const d of ['bin', 'conf.d', 'envhome', 'rel']) mkdirSync(join(root, d));
  stub('nginx', `echo "nginx $*" >> "${root}/calls"; [ "$1" = "-t" ] && exit "\${NGINX_T_RC:-0}"; [ "$1" = "-s" ] && exit "\${NGINX_RELOAD_RC:-0}"; exit 0`);
  stub('systemctl', `echo "systemctl $*" >> "${root}/calls"`);
});
afterEach(() => {
  for (const s of servers) s.kill();
  servers = [];
  rmSync(root, { recursive: true, force: true });
});

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
  it('copies the build into the idle colour with its SHA and BUILD_ID, clears FAILED, and refuses the live colour\'s folder', () => {
    upstream(3111);
    release(3112, 'old', true);
    const repo = build('B1', ['chunks/a.js']);
    run(`bg_sync_release "${repo}" 3112 abc123`);
    const dir = join(root, 'rel', 'isaflow-3112');
    expect({
      server: readFileSync(join(dir, 'server.js'), 'utf8'), sha: readFileSync(join(dir, 'RELEASE_SHA'), 'utf8').trim(),
      sw: readFileSync(join(dir, 'public/sw.js'), 'utf8'), chunk: existsSync(join(dir, '.next/static/chunks/a.js')), failed: existsSync(join(dir, 'FAILED')),
    }).toEqual({ server: '// B1', sha: 'abc123', sw: 'const V = "B1";', chunk: true, failed: false });
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
  const live = () => run('echo "[$(bg_live_port)]"').trim();

  it('writes the upstream, validates, reloads', () => {
    upstream(3111);
    run('bg_switch 3112');
    expect({ live: live(), calls: calls() }).toEqual({ live: '[3112]', calls: ['nginx -t', 'nginx -s reload'] });
  });

  it('a config nginx rejects is rolled back, nginx\'s reason is shown, and nginx is not reloaded', () => {
    upstream(3111);
    expect(() => run('bg_switch 3112', { NGINX_T_RC: '1' })).toThrow(/previous upstream restored. nginx said/);
    expect({ live: live(), calls: calls() }).toEqual({ live: '[3111]', calls: ['nginx -t'] });
  });

  it('a failed reload restores the previous upstream and reloads it', () => {
    upstream(3111);
    expect(() => run('bg_switch 3112', { NGINX_RELOAD_RC: '1' })).toThrow(/reload failed; previous upstream restored/);
    expect(live()).toBe('[3111]');
  });

  it('a stale .prev from an earlier cycle is never restored', () => {
    writeFileSync(join(root, 'conf.d', 'isaflow-live.conf.prev'), 'upstream isaflow_live {\n    server 127.0.0.1:3112;\n}\n');
    expect(() => run('bg_switch 3111', { NGINX_T_RC: '1' })).toThrow(/previous upstream restored/);
    expect({ live: live(), file: existsSync(join(root, 'conf.d', 'isaflow-live.conf')) }).toEqual({ live: '[]', file: false });
  });

  it('refuses a colour marked FAILED', () => {
    upstream(3111);
    release(3112, 'bad', true);
    expect(() => run('bg_switch 3112')).toThrow(/marked FAILED/);
    expect({ live: live(), calls: calls() }).toEqual({ live: '[3111]', calls: [] });
  });
});

describe('bg_start / bg_retire_failed / bg_served_by', () => {
  it('starts an idle colour and waits for it to answer', async () => {
    const port = await serve();
    upstream(3111);
    expect(run(`bg_start ${port} && echo started`, { BG_PORTS: `3111 ${port}` })).toContain('started');
    expect(calls()).toEqual([`systemctl restart isaflow@${port}`]);
  });

  it('refuses to restart the live colour', () => {
    upstream(3111);
    expect(() => run('bg_start 3111')).toThrow(/refusing to restart the LIVE colour/);
    expect(calls()).toEqual([]);
  });

  it('a failed build is disabled, stopped and marked; the live colour never is', () => {
    upstream(3111);
    release(3112, 'new');
    run('bg_retire_failed 3112 "new: VERIFICATION FAILED"');
    expect({ calls: calls(), failed: readFileSync(join(root, 'rel', 'isaflow-3112', 'FAILED'), 'utf8').trim() })
      .toEqual({ calls: ['systemctl disable --now isaflow@3112'], failed: 'new: VERIFICATION FAILED' });
    expect(() => run('bg_retire_failed 3111 x')).toThrow(/is LIVE; not stopping it/);
  });

  it('bg_served_by trusts nginx\'s answer, not the upstream file', async () => {
    const front = await serve('127.0.0.1:3111');
    upstream(3112);
    expect(run('bg_served_by 3111 && echo yes', { BG_FRONT_URL: `http://127.0.0.1:${front}` })).toContain('yes');
    expect(() => run('bg_served_by 3112', { BG_FRONT_URL: `http://127.0.0.1:${front}` })).toThrow(/answers from '127.0.0.1:3111'/);
  }, 30_000);
});

describe('bg_business_hours / bg_midday_migration_check (Johannesburg)', () => {
  /** date answers only for TZ=Africa/Johannesburg; any other zone reads as Sunday 03:00. */
  const clock = (dow: string, hour: string) => stub('date', `[ "$TZ" = Africa/Johannesburg ] || { case "$1" in +%u) echo 7;; +%H) echo 03;; esac; exit 0; }
case "$1" in +%u) echo ${dow};; +%H) echo ${hour};; esac`);
  const hours = (dow: string, hour: string) => { clock(dow, hour); return run('bg_business_hours && echo yes || echo no').trim(); };

  it('weekdays 08:00-16:59, Johannesburg time', () => {
    expect([hours('1', '07'), hours('1', '08'), hours('5', '16'), hours('5', '17'), hours('6', '10'), hours('3', '09')])
      .toEqual(['no', 'yes', 'yes', 'no', 'no', 'yes']);
  });

  const check = (bunOut: string, bunRc = 0) => {
    stub('bun', `printf '%s\\n' "$@" > "${root}/bun-args"; printf '${bunOut}'; exit ${bunRc}`);
    try { return `ok: ${run(`bg_midday_migration_check postgres://x "${root}"`)}`.trim(); } catch (e) { return `refused: ${(e as Error).message}`.trim(); }
  };

  it('in business hours: passes only on an explicit "(none)"; pending, empty or crashed plans refuse', () => {
    clock('2', '10');
    expect(check('Found 9 files\\n  toApply:           (none)\\n')).toBe('ok:');
    expect(readFileSync(join(root, 'bun-args'), 'utf8')).toContain('--dry-run');
    expect(check('  toApply:           948, 949\\n')).toMatch(/^refused: .*pending migrations \(948, 949\)/);
    expect(check('')).toMatch(/^refused: .*pending migrations \(unknown\)/);
    expect(check('boom', 2)).toMatch(/^refused: .*\(unknown\)/);
  });

  it('after hours it does not ask', () => {
    clock('2', '18');
    expect(check('  toApply:           948\\n')).toBe('ok:');
    expect(existsSync(join(root, 'bun-args'))).toBe(false);
  });
});

describe('the :3101 front in the nginx config', () => {
  const site = join(process.cwd(), 'scripts', 'nginx', 'isaflow-combined');
  it('the stripped config (cutover\'s middle step) keeps :80 and drops only the :3101 server', () => {
    const full = readFileSync(site, 'utf8');
    const stripped = run(`bg_site_without_3101 "${site}"`);
    expect({
      fullHas3101: /listen 3101;/.test(full), strippedHas3101: /listen\s+3101/.test(stripped),
      strippedKeeps80: /listen 80;/.test(stripped) && stripped.includes('server_name isaflow.co.za'),
      bothNameColour: (full.match(/X-IsaFlow-Upstream \$upstream_addr always/g) ?? []).length,
    }).toEqual({ fullHas3101: true, strippedHas3101: false, strippedKeeps80: true, bothNameColour: 4 });
  });
});

describe('rollback-deploy.sh / restart-colours.sh', () => {
  const script = (cmd: string, env: Record<string, string> = {}) => bash(cmd, env);

  it('switches back to the other colour, proven by nginx, and records its SHA', async () => {
    const target = await serve();
    const front = await serve(`127.0.0.1:${target}`);
    upstream(3111);
    release(3111, 'new');
    release(target, 'old');
    const out = script('bash scripts/rollback-deploy.sh', {
      BG_PORTS: `3111 ${target}`, BG_FRONT_URL: `http://127.0.0.1:${front}`, HEALTH_URL: `http://127.0.0.1:${front}/api/health`,
    });
    expect({ done: out.includes('Rollback complete'), live: run('bg_live_port', { BG_PORTS: `3111 ${target}` }).trim(),
      sha: readFileSync(join(root, 'envhome', 'RELEASE_SHA'), 'utf8').trim() }).toEqual({ done: true, live: String(target), sha: 'old' });
  }, 30_000);

  it('refuses a FAILED colour, and refuses while a deploy holds the lock', () => {
    upstream(3111);
    release(3111, 'live');
    release(3112, 'bad', true);
    expect(() => script('bash scripts/rollback-deploy.sh')).toThrow(/failed verification/);
    rmSync(join(root, 'rel', 'isaflow-3112', 'FAILED'));
    expect(() => script(`exec 8>"${join(root, 'deploy.lock')}"; flock 8; bash scripts/rollback-deploy.sh`)).toThrow(/already running/);
    expect(run('bg_live_port').trim()).toBe('3111');
  });

  it('restart-colours refuses when the idle colour holds no verified build', () => {
    upstream(3111);
    release(3111, 'live');
    release(3112, 'bad', true);
    expect(() => script('bash scripts/deploy/restart-colours.sh')).toThrow(/holds no verified build/);
    expect(calls()).toEqual([]);
  });
});

describe('deploy.sh order', () => {
  const lines = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8').split('\n');
  const idx = (re: RegExp) => lines.findIndex((l) => !l.trim().startsWith('#') && re.test(l));
  const last = (re: RegExp) => lines.reduce((at, l, i) => (!l.trim().startsWith('#') && re.test(l) ? i : at), -1);

  it('refuses an un-cut-over box and a mid-day migration before the CI gate, and checks the clock again at apply', () => {
    const noLive = idx(/run scripts\/deploy\/cutover\.sh once first/);
    const early = idx(/bg_midday_migration_check "\$EARLY_DB"/);
    const ci = idx(/\$BUN run ci\b/);
    const again = idx(/bg_midday_migration_check "\$PROD_DB"/);
    const apply = idx(/^\s*DATABASE_URL="\$PROD_DB" \$BUN "\$REPO_DIR\/scripts\/apply-migrations\.ts"$/);
    expect([noLive, early, ci, again, apply].every((i) => i > -1)).toBe(true);
    expect(noLive).toBeLessThan(early);
    expect(early).toBeLessThan(ci);
    expect(again).toBeLessThan(apply);
  });

  it('starts the idle colour, verifies it on its own port, adds its static files, and only then switches nginx', () => {
    const start = idx(/^bg_start "\$IDLE_PORT" \|\| fail_idle/);
    const verify = idx(/verify-deploy\.sh" "http:\/\/localhost:\$IDLE_PORT"/);
    const stat = idx(/^bg_sync_static "\$REPO_DIR"/);
    const sw = idx(/^bg_switch "\$IDLE_PORT" \|\| fail_idle/);
    const served = idx(/bg_served_by "\$IDLE_PORT"/);
    expect([start, verify, stat, sw, served].every((i) => i > -1)).toBe(true);
    expect(start).toBeLessThan(verify);
    expect(verify).toBeLessThan(stat);
    expect(stat).toBeLessThan(sw);
    expect(sw).toBeLessThan(served);
    expect(last(/bg_record_live "\$IDLE_PORT"/)).toBeGreaterThan(served);
  });

  it('never restarts, stops or writes the live colour', () => {
    const text = lines.filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(text).not.toMatch(/systemctl (restart|stop|disable)[^\n]*"?\$\{?SERVICE_NAME\}?"?\s*$/m);
    expect(text).not.toMatch(/systemctl (restart|stop|disable)[^\n]*\$\{?LIVE_PORT/);
    expect(text).not.toMatch(/bg_(sync_release|start|retire_failed) [^\n]*\$\{?LIVE_PORT/);
    expect(text).not.toMatch(/rsync[^\n]*"\$DEPLOY_DIR\/"/);
  });
});
