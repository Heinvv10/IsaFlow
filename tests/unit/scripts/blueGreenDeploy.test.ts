/**
 * Blue/green deploy library (scripts/deploy/bluegreen.sh), run for real in bash against a scratch box (blueGreenHarness):
 * stub nginx/systemctl/date/bun, node servers for the colours and for nginx. The scripts that use it are in
 * blueGreenScripts.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Box } from './blueGreenHarness';

let b: Box;
beforeEach(() => { b = new Box(); });
afterEach(() => b.dispose());

describe('bg_live_port / bg_other_port', () => {
  it('reads the live port from the upstream file, and names the other colour', () => {
    b.upstream(3112);
    expect(b.run('echo "$(bg_live_port) $(bg_other_port "$(bg_live_port)")"').trim()).toBe('3112 3111');
  });

  it('is empty with no upstream file (not cut over) or a port that is not a colour', () => {
    expect(b.live()).toBe('[]');
    b.upstream(3101);
    expect(b.live()).toBe('[]');
  });
});

describe('bg_sync_release', () => {
  it('marks the colour unverified, copies the build with its SHA and BUILD_ID, and refuses the live colour\'s folder', () => {
    b.upstream(3111);
    const repo = b.build('B1', ['chunks/a.js']);
    b.run(`bg_sync_release "${repo}" 3112 abc123`);
    const dir = b.path('rel', 'isaflow-3112');
    expect({
      server: readFileSync(join(dir, 'server.js'), 'utf8'), sha: readFileSync(join(dir, 'RELEASE_SHA'), 'utf8').trim(),
      sw: readFileSync(join(dir, 'public/sw.js'), 'utf8'), chunk: existsSync(join(dir, '.next/static/chunks/a.js')), marker: b.marker(3112),
    }).toEqual({ server: '// B1', sha: 'abc123', sw: 'const V = "B1";', chunk: true, marker: 'abc123: files being replaced' });
    expect(() => b.run(`bg_sync_release "${repo}" 3111 abc123`)).toThrow(/refusing to write the LIVE colour/);
    expect(existsSync(b.path('rel', 'isaflow-3111'))).toBe(false);
  });

  it('a copy that fails part-way leaves the colour marked unverified', () => {
    b.upstream(3111);
    const repo = b.build('B1', ['chunks/a.js']);
    b.stub('rsync', `case "$*" in *public*) exit 23;; esac; exec /usr/bin/rsync "$@"`);
    expect(() => b.run(`bg_sync_release "${repo}" 3112 abc123`)).toThrow();
    expect(b.marker(3112)).toBe('abc123: files being replaced');
  });
});

describe('bg_sync_static', () => {
  const served = (f: string) => existsSync(b.path('static', '_next/static', f));

  it('keeps every file of the last BG_KEEP_BUILDS builds and removes only files no kept build has', () => {
    b.run(`bg_sync_static "${b.build('B1', ['chunks/old.js', 'chunks/shared.js'])}"`);
    b.run(`bg_sync_static "${b.build('B2', ['chunks/two.js', 'chunks/shared.js'])}"`);
    expect([served('chunks/old.js'), served('chunks/two.js'), served('chunks/shared.js')]).toEqual([true, true, true]);
    b.run(`sleep 1; bg_sync_static "${b.build('B3', ['chunks/three.js', 'chunks/shared.js'])}"`);
    expect({
      old: served('chunks/old.js'), two: served('chunks/two.js'), three: served('chunks/three.js'), shared: served('chunks/shared.js'),
      lists: b.run(`ls "${b.path('static', '.builds')}"`).trim().split('\n').sort(),
    }).toEqual({ old: false, two: true, three: true, shared: true, lists: ['B2.list', 'B3.list'] });
  });

  it('a build with no static files prunes nothing (empty keep-set fails closed)', () => {
    b.run(`bg_sync_static "${b.build('B1', ['chunks/a.js'])}"`);
    expect(() => b.run(`BG_KEEP_BUILDS=1 bg_sync_static "${b.build('B0', [])}"`)).toThrow(/keep-set is empty/);
    expect(served('chunks/a.js')).toBe(true);
  });
});

describe('bg_switch', () => {
  it('writes the upstream, validates, reloads', () => {
    b.upstream(3111);
    b.run('bg_switch 3112');
    expect({ live: b.live(), calls: b.calls() }).toEqual({ live: '[3112]', calls: ['nginx -t', 'nginx -s reload'] });
  });

  it('a config nginx rejects is rolled back, nginx\'s reason is shown, and nginx is not reloaded', () => {
    b.upstream(3111);
    expect(() => b.run('bg_switch 3112', { NGINX_T_RC: '1' })).toThrow(/previous upstream restored. nginx said/);
    expect({ live: b.live(), calls: b.calls() }).toEqual({ live: '[3111]', calls: ['nginx -t'] });
  });

  it('a failed reload restores the previous upstream and reloads that', () => {
    b.upstream(3111);
    expect(() => b.run('bg_switch 3112', { NGINX_RELOAD_RC: '1' })).toThrow(/reload failed; previous upstream restored/);
    expect({ live: b.live(), calls: b.calls() }).toEqual({ live: '[3111]', calls: ['nginx -t', 'nginx -s reload', 'nginx -s reload'] });
  });

  it('a stale .prev from an earlier cycle is never restored', () => {
    writeFileSync(`${b.upstreamFile}.prev`, 'upstream isaflow_live {\n    server 127.0.0.1:3112;\n}\n');
    expect(() => b.run('bg_switch 3111', { NGINX_T_RC: '1' })).toThrow(/previous upstream restored/);
    expect({ live: b.live(), file: existsSync(b.upstreamFile) }).toEqual({ live: '[]', file: false });
  });

  it('refuses an unverified colour', () => {
    b.upstream(3111);
    b.release(3112, 'bad', 'bad: VERIFICATION FAILED');
    expect(() => b.run('bg_switch 3112')).toThrow(/unverified \(bad: VERIFICATION FAILED\)/);
    expect({ live: b.live(), calls: b.calls() }).toEqual({ live: '[3111]', calls: [] });
  });
});

describe('bg_start / bg_stop_idle / bg_retire_failed / bg_served_by / bg_drain', () => {
  it('starts an idle colour and waits for it to answer', async () => {
    const port = await b.colour();
    b.upstream(3111);
    expect(b.run(`bg_start ${port} && echo started`, { BG_PORTS: `3111 ${port}` })).toContain('started');
    expect(b.calls()).toEqual([`systemctl restart isaflow@${port}`]);
  });

  it('a failed restart fails the start, even when an old process still answers on the port', async () => {
    const port = await b.colour();
    b.upstream(3111);
    b.stub('systemctl', 'exit 1');
    expect(() => b.run(`bg_start ${port}`, { BG_PORTS: `3111 ${port}` })).toThrow();
  });

  it('refuses to restart or stop the live colour', () => {
    b.upstream(3111);
    expect(() => b.run('bg_start 3111')).toThrow(/refusing to restart the LIVE colour/);
    expect(() => b.run('bg_stop_idle 3111')).toThrow(/refusing to stop the LIVE colour/);
    expect(b.calls()).toEqual([]);
  });

  it('a failed build is disabled, stopped and marked; the live colour never is', () => {
    b.upstream(3111);
    b.release(3112, 'new');
    b.run('bg_retire_failed 3112 "new: VERIFICATION FAILED"');
    expect({ calls: b.calls(), marker: b.marker(3112) })
      .toEqual({ calls: ['systemctl disable --now isaflow@3112'], marker: 'new: VERIFICATION FAILED' });
    expect(() => b.run('bg_retire_failed 3111 x')).toThrow(/is LIVE; not stopping it/);
  });

  it('bg_served_by trusts nginx\'s answer, not the upstream file', async () => {
    const front = await b.front('127.0.0.1:3111');
    b.upstream(3112);
    expect(b.run('bg_served_by 3111 && echo yes', { BG_FRONT_URL: `http://127.0.0.1:${front}` })).toContain('yes');
    expect(() => b.run('bg_served_by 3112', { BG_FRONT_URL: `http://127.0.0.1:${front}` })).toThrow(/answers from '127.0.0.1:3111'/);
  }, 30_000);

  it('bg_drain waits while a connection is open to the colour', () => {
    b.stub('ss', `[ -f "${b.root}/busy" ] && echo "ESTAB 0 0 127.0.0.1:3112 127.0.0.1:5555"; true`);
    writeFileSync(b.path('busy'), '');
    const t0 = Date.now();
    expect(b.run('bg_drain 3112', { BG_DRAIN_SECS: '2' })).toMatch(/still has connections after 2s/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
  });
});

describe('bg_business_hours / bg_midday_migration_check (Johannesburg)', () => {
  /** date answers only for TZ=Africa/Johannesburg; any other zone reads as Sunday 03:00. */
  const clock = (dow: string, hour: string) => b.stub('date', `[ "$TZ" = Africa/Johannesburg ] || { case "$1" in +%u) echo 7;; +%H) echo 03;; esac; exit 0; }
case "$1" in +%u) echo ${dow};; +%H) echo ${hour};; esac`);
  const hours = (dow: string, hour: string) => { clock(dow, hour); return b.run('bg_business_hours && echo yes || echo no').trim(); };

  it('weekdays 08:00-16:59, Johannesburg time', () => {
    expect([hours('1', '07'), hours('1', '08'), hours('5', '16'), hours('5', '17'), hours('6', '10'), hours('3', '09')])
      .toEqual(['no', 'yes', 'yes', 'no', 'no', 'yes']);
  });

  const check = (bunOut: string, bunRc = 0) => {
    b.stub('bun', `printf '%s\\n' "$@" > "${b.root}/bun-args"; printf '${bunOut}'; exit ${bunRc}`);
    try { return `ok: ${b.run(`bg_midday_migration_check postgres://x "${b.root}"`)}`.trim(); } catch (e) { return `refused: ${(e as Error).message}`.trim(); }
  };

  it('in business hours: passes only on an explicit "(none)"; pending, empty or crashed plans refuse', () => {
    clock('2', '10');
    expect(check('Found 9 files\\n  toApply:           (none)\\n')).toBe('ok:');
    expect(readFileSync(b.path('bun-args'), 'utf8')).toContain('--dry-run');
    expect(check('  toApply:           948, 949\\n')).toMatch(/^refused: .*pending migrations \(948, 949\)/);
    expect(check('')).toMatch(/^refused: .*pending migrations \(unknown\)/);
    expect(check('boom', 2)).toMatch(/^refused: .*\(unknown\)/);
  });

  it('after hours it does not ask', () => {
    clock('2', '18');
    expect(check('  toApply:           948\\n')).toBe('ok:');
    expect(existsSync(b.path('bun-args'))).toBe(false);
  });
});

describe('the nginx site config', () => {
  const site = join(process.cwd(), 'scripts', 'nginx', 'isaflow-combined');
  it('the stripped config (cutover\'s middle step) keeps :80 and drops only the :3101 server; the colour header is probe-only', () => {
    const full = readFileSync(site, 'utf8');
    const stripped = b.run(`bg_site_without_3101 "${site}"`);
    expect({
      fullHas3101: /listen 3101;/.test(full), strippedHas3101: /listen\s+3101/.test(stripped),
      strippedKeeps80: /listen 80;/.test(stripped) && stripped.includes('server_name isaflow.co.za'),
      probeHeaders: (full.match(/add_header X-IsaFlow-Upstream \$isaflow_upstream_probe always;/g) ?? []).length,
      anyUnconditional: /add_header X-IsaFlow-Upstream \$upstream_addr/.test(full),
      probeMap: /map \$http_x_isaflow_probe \$isaflow_upstream_probe \{\s*"1"\s+\$upstream_addr;\s*default "";/.test(full),
    }).toEqual({ fullHas3101: true, strippedHas3101: false, strippedKeeps80: true, probeHeaders: 4, anyUnconditional: false, probeMap: true });
  });
});
