/**
 * The blue/green scripts run for real against a scratch box (blueGreenHarness): deploy.sh's colour steps
 * (bg_deploy_release, called the way deploy.sh calls it: under `if !`, so errexit is off inside), rollback-deploy.sh
 * and restart-colours.sh. cutover.sh is in blueGreenCutover.test.ts. deploy.sh as a whole cannot run (it deploys
 * production); its wiring is checked as text at the end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Box } from './blueGreenHarness';

let b: Box;
beforeEach(() => { b = new Box(); });
afterEach(() => b.dispose());

/** Two running colours (live = A), nginx's stand-in following the upstream file, and the public URL on it. */
async function world() {
  const [A, B, front] = [await b.colour(), await b.colour(), await b.front()];
  const env = { BG_PORTS: `${A} ${B}`, BG_FRONT_URL: `http://127.0.0.1:${front}`, BG_PUBLIC_HEALTH: `http://127.0.0.1:${front}/api/health` };
  Object.assign(b.env, env);
  b.upstream(A);
  b.release(A, 'live-sha');
  b.release(B, 'old-sha');
  writeFileSync(b.env.BG_UNIT_FILE, '# unit before');
  return { A, B, front, env };
}
const idleSha = (port: number) => readFileSync(b.path('rel', `isaflow-${port}`, 'RELEASE_SHA'), 'utf8').trim();

describe('bg_deploy_release (deploy.sh steps 4-7)', () => {
  /** As deploy.sh calls it: `if ! bg_deploy_release`, so set -e is off inside, with both lock fds open. */
  const deploy = (repo: string, verify = 'echo "VERIFY $1"', env: Record<string, string> = {}) => b.run(`exec 9>/dev/null
verify() { [ -e /dev/fd/8 ] && echo FD8-OPEN; [ -e /dev/fd/9 ] && echo FD9-OPEN; ${verify}; }
BG_VERIFY=verify; bg_lock
rc=0; bg_deploy_release "${repo}" new-sha || rc=$?
if [ "$rc" -ne 0 ]; then echo "DEPLOY-FAILED rc=$rc"; exit 1; fi`, env);

  it('stops, replaces, starts and verifies the idle colour (lock fds closed), publishes its static files, then switches', async () => {
    const { A, B } = await world();
    const out = deploy(b.build('N1', ['chunks/n.js']));
    expect({
      verified: out.includes(`VERIFY http://localhost:${B}`), fdsLeaked: /FD[89]-OPEN/.test(out), live: b.live(), marker: b.marker(B),
      sha: readFileSync(b.path('envhome', 'RELEASE_SHA'), 'utf8').trim(), chunk: existsSync(b.path('static', '_next/static/chunks/n.js')),
      unit: readFileSync(b.env.BG_UNIT_FILE, 'utf8'), unitPrev: existsSync(`${b.env.BG_UNIT_FILE}.prev`),
      liveTouched: b.calls().some((c) => c.includes(`isaflow@${A}`)),
      order: b.calls().filter((c) => c.startsWith('systemctl') && c.includes(`@${B}`) && !c.includes('is-active')),
    }).toEqual({
      verified: true, fdsLeaked: false, live: `[${B}]`, marker: null, sha: 'new-sha', chunk: true, unit: '# unit for N1', unitPrev: false,
      liveTouched: false, order: [`systemctl stop isaflow@${B}`, `systemctl enable isaflow@${B}`, `systemctl restart isaflow@${B}`],
    });
  }, 30_000);

  it('a failed verification retires the idle colour, puts the unit back, and users never move', async () => {
    const { A, B } = await world();
    expect(() => deploy(b.build('N1', ['chunks/n.js']), 'return 1')).toThrow(/VERIFICATION FAILED — users stay on isaflow@[\s\S]*DEPLOY-FAILED/);
    expect({
      live: b.live(), marker: b.marker(B), retired: b.calls().includes(`systemctl disable --now isaflow@${B}`),
      unit: readFileSync(b.env.BG_UNIT_FILE, 'utf8'), chunk: existsSync(b.path('static', '_next/static/chunks/n.js')),
    }).toEqual({ live: `[${A}]`, marker: 'new-sha: VERIFICATION FAILED', retired: true, unit: '# unit before', chunk: false });
  }, 30_000);

  it('a failed unit install retires the idle colour; nothing is started or switched', async () => {
    const { A, B } = await world();
    b.wrapSystemctl(`  "enable "*) echo "systemctl $*" >> "${b.root}/calls"; exit 1;;`);
    expect(() => deploy(b.build('N1', []))).toThrow(/unit install failed[\s\S]*DEPLOY-FAILED/);
    expect({ live: b.live(), marker: b.marker(B), started: b.calls().includes(`systemctl restart isaflow@${B}`), unit: readFileSync(b.env.BG_UNIT_FILE, 'utf8') })
      .toEqual({ live: `[${A}]`, marker: 'new-sha: unit install failed', started: false, unit: '# unit before' });
  }, 30_000);

  it('an idle colour that will not stop is left untouched: no copy, no switch', async () => {
    const { A, B } = await world();
    b.wrapSystemctl('  "is-active --quiet isaflow@"*) exit 0;;');   // still running after the stop
    expect(() => deploy(b.build('N1', []))).toThrow(/still running after stop[\s\S]*DEPLOY-FAILED/);
    expect({ live: b.live(), idle: idleSha(B), marker: b.marker(B) }).toEqual({ live: `[${A}]`, idle: 'old-sha', marker: null });
  }, 30_000);

  it('a copy that fails part-way (errexit off, as in deploy.sh) retires the idle colour; nothing is started or switched', async () => {
    const { A, B } = await world();
    b.stub('rsync', `case "$*" in *public*) exit 23;; esac; exec /usr/bin/rsync "$@"`);
    expect(() => deploy(b.build('N1', []))).toThrow(/DEPLOY-FAILED rc=1/);
    expect({ live: b.live(), marker: b.marker(B), started: b.calls().includes(`systemctl restart isaflow@${B}`) })
      .toEqual({ live: `[${A}]`, marker: 'new-sha: copy failed', started: false });
  }, 30_000);

  it('an unchanged unit template is not replaced (the live colour keeps restarting from the same one)', async () => {
    const { B } = await world();
    const repo = b.build('N1', ['chunks/n.js']);
    writeFileSync(b.env.BG_UNIT_FILE, readFileSync(join(repo, 'scripts/isaflow@.service')));
    deploy(repo);
    expect({ reloaded: b.calls().includes('systemctl daemon-reload'), live: b.live() }).toEqual({ reloaded: false, live: `[${B}]` });
  }, 30_000);

  it('when the switch back also fails it says so (rc 2): nginx state unknown', async () => {
    const { A } = await world();
    const stuck = await b.front(`127.0.0.1:${A}`);
    b.stub('nginx', `echo "nginx $*" >> "${b.root}/calls"; [ "$1" = "-t" ] && { n=$(cat "${b.root}/t" 2>/dev/null || echo 0); echo $((n+1)) > "${b.root}/t"; [ "$n" -eq 0 ]; exit; }; exit 0`);
    expect(() => deploy(b.build('N1', ['chunks/n.js']), undefined, { BG_FRONT_URL: `http://127.0.0.1:${stuck}` })).toThrow(/SWITCH-BACK FAILED[\s\S]*DEPLOY-FAILED rc=2/);
  }, 60_000);

  it('refuses before touching anything when nginx does not serve the colour the file names', async () => {
    const { A, B } = await world();
    const front = await b.front(`127.0.0.1:${B}`);
    expect(() => deploy(b.build('N1', []), undefined, { BG_FRONT_URL: `http://127.0.0.1:${front}` })).toThrow(/nginx is not serving isaflow@/);
    expect({ live: b.live(), calls: b.calls(), idle: idleSha(B) }).toEqual({ live: `[${A}]`, calls: [], idle: 'old-sha' });
  }, 30_000);

  it('if nginx does not answer from the new colour after the switch, it switches back; the verified build stays verified', async () => {
    const { A, B } = await world();
    const stuck = await b.front(`127.0.0.1:${A}`);
    expect(() => deploy(b.build('N1', ['chunks/n.js']), undefined, { BG_FRONT_URL: `http://127.0.0.1:${stuck}` })).toThrow(/switching back to isaflow@/);
    expect({ live: b.live(), marker: b.marker(B) }).toEqual({ live: `[${A}]`, marker: null });
  }, 60_000);
});

describe('rollback-deploy.sh', () => {
  const rollback = (env: Record<string, string> = {}) => b.bash('bash scripts/rollback-deploy.sh', env);

  it('switches to the other colour, proven by nginx, records its SHA, and marks the release it left', async () => {
    const { A, B } = await world();
    expect(rollback()).toContain('Rollback complete');
    expect({ live: b.live(), sha: readFileSync(b.path('envhome', 'RELEASE_SHA'), 'utf8').trim(), left: b.marker(A) })
      .toEqual({ live: `[${B}]`, sha: 'old-sha', left: expect.stringMatching(/^live-sha: rolled back from/) });
    expect(() => rollback()).toThrow(/is unverified: live-sha: rolled back from/);
    expect(b.live()).toBe(`[${B}]`);
  }, 60_000);

  it('starts the previous colour first when it is not running', async () => {
    const { A } = await world();
    const down = await b.freePort();
    b.release(down, 'old-sha');
    b.env.BG_PORTS = `${A} ${down}`;
    expect(rollback()).toContain('Starting isaflow@');
    expect(b.live()).toBe(`[${down}]`);
  }, 60_000);

  it('refuses an unverified colour, the same release, a file nginx disagrees with, and while colours are being changed', async () => {
    const { A, B } = await world();
    b.run(`bg_sync_release "${b.build('N1', [])}" ${B} aborted-sha`);       // a deploy killed after its copy
    expect(() => rollback()).toThrow(/is unverified: aborted-sha: files being replaced/);
    b.release(B, 'live-sha');
    b.run(`bg_clear_marker ${B}`);
    expect(() => rollback()).toThrow(/holds the same release \(live-sha\)/);
    b.release(B, 'old-sha');
    const wrong = await b.front(`127.0.0.1:${B}`);
    expect(() => rollback({ BG_FRONT_URL: `http://127.0.0.1:${wrong}` })).toThrow(/nginx is not serving isaflow@/);
    expect(() => b.bash(`exec 7>"${b.env.BG_LOCK_FILE}"; flock 7; bash scripts/rollback-deploy.sh`)).toThrow(/changing colours now/);
    expect(b.live()).toBe(`[${A}]`);
  }, 90_000);
});

describe('restart-colours.sh', () => {
  it('restarts both colours on the LIVE release, verifying the restarted one before users reach it', async () => {
    const { A, B } = await world();
    const out = b.bash('bash scripts/deploy/restart-colours.sh', { BG_VERIFY: 'echo' });
    expect({
      done: out.includes('Both colours run live-sha'), verified: out.includes(`http://localhost:${B}`), live: b.live(),
      served: idleSha(B), a: idleSha(A), marker: b.marker(B), restarts: b.calls().filter((c) => c.startsWith('systemctl restart')),
    }).toEqual({ done: true, verified: true, live: `[${B}]`, served: 'live-sha', a: 'live-sha', marker: null,
      restarts: [`systemctl restart isaflow@${B}`, `systemctl restart isaflow@${A}`] });
  }, 60_000);

  it('a restarted colour that fails verification with the new env never takes traffic', async () => {
    const { A, B } = await world();
    expect(() => b.bash('bash scripts/deploy/restart-colours.sh', { BG_VERIFY: 'false' })).toThrow(/failed verification with the new env/);
    expect({ live: b.live(), marker: b.marker(B), aRestarted: b.calls().includes(`systemctl restart isaflow@${A}`) })
      .toEqual({ live: `[${A}]`, marker: 'live-sha: failed verification with the new env', aRestarted: false });
  }, 60_000);
});

describe('deploy.sh wiring', () => {
  const lines = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8').split('\n');
  const idx = (re: RegExp) => lines.findIndex((l) => !l.trim().startsWith('#') && re.test(l));

  it('refuses an un-cut-over box, a file nginx disagrees with, and a mid-day migration before the CI gate; checks the clock again before migrating', () => {
    const at = {
      noLive: idx(/run scripts\/deploy\/cutover\.sh once first/), served: idx(/^bg_served_by "\$LIVE_PORT" \|\| exit 1$/),
      drained: idx(/^bg_drain "\$IDLE_PORT" \|\| exit 1$/),
      early: idx(/^bg_midday_migration_check "\$EARLY_DB" "\$REPO_DIR" \|\| exit 1$/), ci: idx(/\$BUN run ci\b/),
      again: idx(/^bg_midday_migration_check "\$\(owner_database_url_for .*\)" "\$REPO_DIR" \|\| exit 1$/),
      apply: idx(/^\s*DATABASE_URL="\$PROD_DB" \$BUN "\$REPO_DIR\/scripts\/apply-migrations\.ts"$/),
    };
    expect(Object.values(at).every((i) => i > -1)).toBe(true);
    expect([at.noLive < at.served, at.served < at.drained, at.drained < at.ci, at.served < at.early, at.early < at.ci, at.ci < at.again, at.again < at.apply])
      .toEqual([true, true, true, true, true, true, true]);
  });

  it('runs the colour steps under the colour lock (waiting for a rollback), after migrations, with the verification gate', () => {
    const at = { apply: idx(/apply-migrations\.ts"$/), lock: idx(/^bg_lock \d+ \|\| exit 1\b/), run: idx(/^DEPLOY_RC=0; bg_deploy_release "\$REPO_DIR" "\$GIT_SHA" \|\| DEPLOY_RC=\$\?$/) };
    expect([at.apply > -1, at.apply < at.lock, at.lock < at.run]).toEqual([true, true, true]);
    expect(lines.join('\n')).toMatch(/BG_VERIFY=verify_idle/);
    expect(lines.join('\n')).toMatch(/DATABASE_URL="\$PROD_DB" bash "\$REPO_DIR\/scripts\/verify-deploy\.sh" "\$1"/);
  });
});
