/**
 * The blue/green scripts run for real against a scratch box (blueGreenHarness): deploy.sh's colour steps
 * (bg_deploy_release), rollback-deploy.sh, restart-colours.sh and cutover.sh. deploy.sh as a whole cannot run (it
 * deploys production); its wiring is checked as text at the end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Box } from './blueGreenHarness';

let b: Box;
beforeEach(() => { b = new Box(); });
afterEach(() => b.dispose());

/** Two running colours (live = A), nginx's stand-in following the upstream file, and the public URL on it. */
async function world() {
  const [A, B, front] = [await b.colour(), await b.colour(), await b.front()];
  const env = { BG_PORTS: `${A} ${B}`, BG_FRONT_URL: `http://127.0.0.1:${front}`, BG_PUBLIC_HEALTH: `http://127.0.0.1:${front}/api/health` };
  b.env.BG_PORTS = env.BG_PORTS;
  b.upstream(A);
  b.release(A, 'live-sha');
  b.release(B, 'old-sha');
  writeFileSync(b.env.BG_UNIT_FILE, '# unit before');
  return { A, B, front, env };
}

describe('bg_deploy_release (deploy.sh steps 4-7)', () => {
  const deploy = (repo: string, env: Record<string, string>, verify = 'echo "VERIFY $1"') => b.run(`exec 9>/dev/null
verify() { [ -e /dev/fd/8 ] && echo FD8-OPEN; [ -e /dev/fd/9 ] && echo FD9-OPEN; ${verify}; }
BG_VERIFY=verify; bg_lock; bg_deploy_release "${repo}" new-sha`, env);

  it('stops, replaces, starts and verifies the idle colour (lock fds closed), publishes its static files, then switches', async () => {
    const { A, B, env } = await world();
    const out = deploy(b.build('N1', ['chunks/n.js']), env);
    expect({
      verified: out.includes(`VERIFY http://localhost:${B}`), fdsLeaked: /FD[89]-OPEN/.test(out), live: b.live(), marker: b.marker(B),
      sha: readFileSync(b.path('envhome', 'RELEASE_SHA'), 'utf8').trim(), chunk: existsSync(b.path('static', '_next/static/chunks/n.js')),
      unit: readFileSync(b.env.BG_UNIT_FILE, 'utf8'), unitPrev: existsSync(`${b.env.BG_UNIT_FILE}.prev`),
      liveTouched: b.calls().some((c) => c.includes(`isaflow@${A}`)),
      order: b.calls().filter((c) => c.startsWith('systemctl') && c.includes(`@${B}`)),
    }).toEqual({
      verified: true, fdsLeaked: false, live: `[${B}]`, marker: null, sha: 'new-sha', chunk: true, unit: '# unit for N1', unitPrev: false,
      liveTouched: false, order: [`systemctl stop isaflow@${B}`, `systemctl enable isaflow@${B}`, `systemctl restart isaflow@${B}`],
    });
  }, 30_000);

  it('a failed verification retires the idle colour, puts the unit back, and users never move', async () => {
    const { A, B, env } = await world();
    expect(() => deploy(b.build('N1', ['chunks/n.js']), env, 'return 1')).toThrow(/VERIFICATION FAILED — users stay on isaflow@/);
    expect({
      live: b.live(), marker: b.marker(B), retired: b.calls().includes(`systemctl disable --now isaflow@${B}`),
      unit: readFileSync(b.env.BG_UNIT_FILE, 'utf8'), chunk: existsSync(b.path('static', '_next/static/chunks/n.js')),
    }).toEqual({ live: `[${A}]`, marker: 'new-sha: VERIFICATION FAILED', retired: true, unit: '# unit before', chunk: false });
  }, 30_000);

  it('refuses before touching anything when nginx does not serve the colour the file names', async () => {
    const { A, B, env } = await world();
    const front = await b.front(`127.0.0.1:${B}`);
    expect(() => deploy(b.build('N1', []), { ...env, BG_FRONT_URL: `http://127.0.0.1:${front}` })).toThrow(/nginx is not serving isaflow@/);
    expect({ live: b.live(), calls: b.calls(), idleSha: readFileSync(b.path('rel', `isaflow-${B}`, 'RELEASE_SHA'), 'utf8').trim() })
      .toEqual({ live: `[${A}]`, calls: [], idleSha: 'old-sha' });
  }, 30_000);

  it('if nginx does not answer from the new colour after the switch, it switches back; the verified build stays verified', async () => {
    const { A, B, env } = await world();
    const stuck = await b.front(`127.0.0.1:${A}`);
    const env2 = { ...env, BG_FRONT_URL: `http://127.0.0.1:${stuck}` };
    expect(() => deploy(b.build('N1', ['chunks/n.js']), env2)).toThrow(/switching back to isaflow@/);
    expect({ live: b.live(), marker: b.marker(B) }).toEqual({ live: `[${A}]`, marker: null });
  }, 60_000);
});

describe('rollback-deploy.sh', () => {
  const rollback = (env: Record<string, string>) => b.bash('bash scripts/rollback-deploy.sh', env);

  it('switches to the other colour, proven by nginx, records its SHA, and marks the release it left', async () => {
    const { A, B, env } = await world();
    expect(rollback(env)).toContain('Rollback complete');
    expect({ live: b.live(), sha: readFileSync(b.path('envhome', 'RELEASE_SHA'), 'utf8').trim(), left: b.marker(A) })
      .toEqual({ live: `[${B}]`, sha: 'old-sha', left: expect.stringMatching(/^live-sha: rolled back from/) });
    expect(() => rollback(env)).toThrow(/is unverified: live-sha: rolled back from/);
    expect(b.live()).toBe(`[${B}]`);
  }, 60_000);

  it('starts the previous colour first when it is not running', async () => {
    const { A, env } = await world();
    const down = await b.freePort();
    b.release(down, 'old-sha');
    writeFileSync(b.path('start-colours'), '');
    b.env.BG_PORTS = `${A} ${down}`;
    expect(rollback({ ...env, BG_PORTS: b.env.BG_PORTS })).toContain('Starting isaflow@');
    expect(b.live()).toBe(`[${down}]`);
  }, 60_000);

  it('refuses an unverified colour (a failed or aborted deploy) and refuses while colours are being changed', async () => {
    const { A, B, env } = await world();
    b.run(`bg_sync_release "${b.build('N1', [])}" ${B} aborted-sha`, env);       // a deploy killed after its copy
    expect(() => rollback(env)).toThrow(/is unverified: aborted-sha: files being replaced/);
    b.release(B, 'old-sha');
    b.run(`bg_clear_marker ${B}`, env);
    expect(() => b.bash(`exec 7>"${b.env.BG_LOCK_FILE}"; flock 7; bash scripts/rollback-deploy.sh`, env)).toThrow(/changing colours now/);
    expect(b.live()).toBe(`[${A}]`);
  }, 30_000);
});

describe('restart-colours.sh', () => {
  it('restarts both colours on the LIVE release: the code users run does not change', async () => {
    const { A, B, env } = await world();
    expect(b.bash('bash scripts/deploy/restart-colours.sh', env)).toContain('Both colours run live-sha');
    expect({
      live: b.live(), served: readFileSync(b.path('rel', `isaflow-${B}`, 'RELEASE_SHA'), 'utf8').trim(),
      a: readFileSync(b.path('rel', `isaflow-${A}`, 'RELEASE_SHA'), 'utf8').trim(), marker: b.marker(B),
      restarts: b.calls().filter((c) => c.startsWith('systemctl restart')),
    }).toEqual({ live: `[${B}]`, served: 'live-sha', a: 'live-sha', marker: null,
      restarts: [`systemctl restart isaflow@${B}`, `systemctl restart isaflow@${A}`] });
  }, 60_000);
});

describe('cutover.sh', () => {
  async function box() {
    const [A, front] = [await b.colour(), await b.front()];
    const old = b.path('old');
    mkdirSync(join(old, '.next/static/chunks'), { recursive: true });
    writeFileSync(join(old, 'server.js'), '// live');
    writeFileSync(join(old, 'RELEASE_SHA'), 'live-sha\n');
    writeFileSync(join(old, '.env.local'), 'SECRET=1');
    writeFileSync(join(old, '.next/BUILD_ID'), 'L1');
    writeFileSync(join(old, '.next/static/chunks/l.js'), 'l');
    writeFileSync(b.path('site'), ['# today\'s site: everything to isaflow.service on :3101', 'server {', '    listen 80;',
      '    server_name isaflow.co.za www.isaflow.co.za app.isaflow.co.za;', '    client_max_body_size 50M;', '    location /auth/v1/ {',
      '        proxy_pass http://localhost:7770;', '    }', '    location / {', '        proxy_pass http://localhost:3101;', '    }', '}', ''].join('\n'));
    writeFileSync(b.path('isaflow.service'), '[Service]');
    writeFileSync(b.path('old-active'), '');
    b.stub('date', 'case "$1" in +%u) echo 2;; +%H) echo 19;; esac');
    b.stub('ss', 'true');   // :3101 is free in the scratch box (the real one is production's)
    const url = `http://127.0.0.1:${front}`;
    b.env.BG_PORTS = `${A} 3112`;
    const env = {
      BG_PORTS: `${A} 3112`, BG_FRONT_URL: url, BG_PUBLIC_HEALTH: `${url}/api/health`, CUTOVER_SITE: b.path('site'),
      CUTOVER_SITE_BACKUP: b.path('site.pre'), CUTOVER_OLD_UNIT: b.path('isaflow.service'), CUTOVER_OLD_UNIT_BACKUP: b.path('isaflow.service.pre'),
      CUTOVER_OLD_DIR: old, CUTOVER_OLD_HEALTH: `${url}/api/health`, CUTOVER_FRONT80: url, CUTOVER_WORK: b.path('work'),
    };
    return { A, env };
  }
  const cutover = (env: Record<string, string>, args = '') => b.bash(`bash scripts/deploy/cutover.sh ${args}`, env);
  const site = () => readFileSync(b.path('site'), 'utf8');
  const repoSite = () => readFileSync('scripts/nginx/isaflow-combined', 'utf8');

  it('without CUTOVER_CONFIRM it shows the change and changes nothing, at any hour', async () => {
    const { env } = await box();
    b.stub('date', 'case "$1" in +%u) echo 2;; +%H) echo 10;; esac');
    expect(cutover(env)).toContain('Nothing changed');
    expect({ upstream: existsSync(b.upstreamFile), calls: b.calls() }).toEqual({ upstream: false, calls: ['systemctl cat isaflow.service'] });
    expect(() => cutover({ ...env, CUTOVER_CONFIRM: 'yes' })).toThrow(/after hours only/);
  }, 30_000);

  it('cuts over: colour seeded from the live release (no env files), :80 then :3101 to nginx, old unit moved and masked', async () => {
    const { A, env } = await box();
    expect(cutover({ ...env, CUTOVER_CONFIRM: 'yes' })).toContain('Cutover complete');
    const calls = b.calls();
    expect({
      live: b.live(), site: site() === repoSite(), unitMoved: !existsSync(b.path('isaflow.service')) && existsSync(b.path('isaflow.service.pre')),
      marker: b.marker(A), envCopied: existsSync(b.path('rel', `isaflow-${A}`, '.env.local')),
      seeded: readFileSync(b.path('rel', `isaflow-${A}`, 'RELEASE_SHA'), 'utf8').trim(), chunk: existsSync(b.path('static', '_next/static/chunks/l.js')),
      order: calls.filter((c) => /isaflow\.service$/.test(c) && !c.includes('cat')),
    }).toEqual({
      live: `[${A}]`, site: true, unitMoved: true, marker: null, envCopied: false, seeded: 'live-sha', chunk: true,
      order: ['systemctl disable --now isaflow.service', 'systemctl mask isaflow.service'],
    });
  }, 60_000);

  it('if nginx cannot take :3101, isaflow.service is put straight back and the old unit stays where it was', async () => {
    const { env } = await box();
    expect(() => cutover({ ...env, CUTOVER_CONFIRM: 'yes', NGINX_T_FAIL_IF: 'listen 3101' })).toThrow(/could not take :3101; putting isaflow.service back/);
    expect({
      oldRunning: existsSync(b.path('old-active')), unitInPlace: existsSync(b.path('isaflow.service')),
      siteHas3101: /listen\s+3101/.test(site()), masked: b.calls().includes('systemctl mask isaflow.service'),
    }).toEqual({ oldRunning: true, unitInPlace: true, siteHas3101: false, masked: false });
  }, 90_000);

  it('--undo after a full cutover puts isaflow.service back on the live release and keeps every env file', async () => {
    const { A, env } = await box();
    const before = site();
    writeFileSync(b.path('old', '.env.local.pre-s07b'), 'OLD=1');
    cutover({ ...env, CUTOVER_CONFIRM: 'yes' });
    writeFileSync(b.path('rel', `isaflow-${A}`, 'server.js'), '// live colour');
    expect(cutover(env, '--undo')).toContain('Undo complete');
    expect({
      site: site() === before, upstream: existsSync(b.upstreamFile), unit: existsSync(b.path('isaflow.service')), running: existsSync(b.path('old-active')),
      code: readFileSync(b.path('old', 'server.js'), 'utf8'), envKept: [existsSync(b.path('old', '.env.local')), existsSync(b.path('old', '.env.local.pre-s07b'))],
    }).toEqual({ site: true, upstream: false, unit: true, running: true, code: '// live colour', envKept: [true, true] });
  }, 90_000);

  it('--undo after a half-done cutover (isaflow.service still running) restores the old site and stops the colours', async () => {
    const { A, env } = await box();
    const before = site();
    writeFileSync(b.path('site.pre'), before);
    writeFileSync(b.path('site'), repoSite());
    b.upstream(A);
    expect(cutover(env, '--undo')).toContain('Undo complete');
    expect({ site: site() === before, upstream: existsSync(b.upstreamFile), stopped: b.calls().includes(`systemctl disable --now isaflow@${A}`) })
      .toEqual({ site: true, upstream: false, stopped: true });
  }, 60_000);
});

describe('deploy.sh wiring', () => {
  const lines = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8').split('\n');
  const idx = (re: RegExp) => lines.findIndex((l) => !l.trim().startsWith('#') && re.test(l));

  it('refuses an un-cut-over box, a file nginx disagrees with, and a mid-day migration before the CI gate; checks the clock again before migrating', () => {
    const at = {
      noLive: idx(/run scripts\/deploy\/cutover\.sh once first/), served: idx(/^bg_served_by "\$LIVE_PORT" \|\| exit 1/),
      early: idx(/bg_midday_migration_check "\$EARLY_DB"/), ci: idx(/\$BUN run ci\b/), again: idx(/^bg_midday_migration_check "\$\(owner_database_url_for/),
      apply: idx(/^\s*DATABASE_URL="\$PROD_DB" \$BUN "\$REPO_DIR\/scripts\/apply-migrations\.ts"$/),
    };
    expect(Object.values(at).every((i) => i > -1)).toBe(true);
    expect([at.noLive < at.served, at.served < at.early, at.early < at.ci, at.ci < at.again, at.again < at.apply]).toEqual([true, true, true, true, true]);
  });

  it('runs the colour steps under the colour lock, after migrations, with the verification gate', () => {
    const at = { apply: idx(/apply-migrations\.ts"$/), lock: idx(/^bg_lock \|\| exit 1/), run: idx(/^if ! bg_deploy_release "\$REPO_DIR" "\$GIT_SHA"; then/) };
    expect([at.apply < at.lock, at.lock < at.run]).toEqual([true, true]);
    expect(lines.join('\n')).toMatch(/BG_VERIFY=verify_idle/);
    expect(lines.join('\n')).toMatch(/DATABASE_URL="\$PROD_DB" bash "\$REPO_DIR\/scripts\/verify-deploy\.sh" "\$1"/);
  });
});
