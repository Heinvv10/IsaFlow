/**
 * scripts/deploy/cutover.sh run for real against a scratch box (blueGreenHarness): stub nginx/systemctl/ss/date, a
 * stand-in for isaflow.service that answers only while the stub systemctl has it running, and one for nginx that
 * names the colour in the upstream file to a request carrying the probe token. `ss` reports :3101 taken while
 * isaflow.service runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Box } from './blueGreenHarness';

let b: Box;
beforeEach(() => { b = new Box(); });
afterEach(() => b.dispose());

const TODAY = ['# today\'s site: everything to isaflow.service on :3101', 'server {', '    listen 80;',
  '    server_name isaflow.co.za www.isaflow.co.za app.isaflow.co.za;', '    client_max_body_size 50M;', '    location /auth/v1/ {',
  '        proxy_pass http://localhost:7770;', '    }', '    location / {', '        proxy_pass http://localhost:3101;', '    }', '}', ''].join('\n');
const repoSite = () => readFileSync('scripts/nginx/isaflow-combined', 'utf8');
const site = () => readFileSync(b.path('site'), 'utf8');

async function box(hour = '19') {
  const [A, front, port80, old] = [await b.colour(), await b.front(), await b.front80(), await b.oldService()];
  const dir = b.path('old');
  mkdirSync(join(dir, '.next/static/chunks'), { recursive: true });
  writeFileSync(join(dir, 'server.js'), '// live');
  writeFileSync(join(dir, 'RELEASE_SHA'), 'live-sha\n');
  writeFileSync(join(dir, '.env.local'), 'SECRET=1');
  writeFileSync(join(dir, '.next/BUILD_ID'), 'L1');
  writeFileSync(join(dir, '.next/static/chunks/l.js'), 'l');
  writeFileSync(b.path('site'), TODAY);
  writeFileSync(b.path('site-available'), TODAY);
  writeFileSync(b.path('isaflow.service'), '[Service]');
  writeFileSync(b.path('old-active'), '');
  mkdirSync(b.path('stage'));
  b.stub('date', `case "$1" in +%u) echo 2;; +%H) echo ${hour};; esac`);
  b.stub('ss', `[ -f "${b.root}/old-active" ] && [[ "$*" == *3101* ]] && echo "LISTEN 0 511 *:3101 *:*"; true`);
  const url = `http://127.0.0.1:${front}`;
  Object.assign(b.env, {
    BG_PORTS: `${A} 3112`, BG_FRONT_URL: url, BG_PUBLIC_HEALTH: `http://127.0.0.1:${port80}/api/health`, CUTOVER_SITE: b.path('site'),
    CUTOVER_SITE_AVAILABLE: b.path('site-available'), CUTOVER_STAGE: b.path('stage'), CUTOVER_OLD_UNIT: b.path('isaflow.service'),
    CUTOVER_OLD_UNIT_BACKUP: b.path('isaflow.service.pre'), CUTOVER_OLD_DIR: dir, CUTOVER_OLD_HEALTH: `http://127.0.0.1:${old}/api/health`,
    CUTOVER_FRONT80: `http://127.0.0.1:${port80}`, CUTOVER_WORK: b.path('work'), BG_VERIFY: 'true',
  });
  return { A, front };
}
const cutover = (args = '', env: Record<string, string> = {}) => b.bash(`bash scripts/deploy/cutover.sh ${args}`, env);

describe('cutover.sh', () => {
  it('without CUTOVER_CONFIRM it shows the change and changes nothing, at any hour; the cutover itself is after hours only', async () => {
    await box('10');
    expect(cutover()).toContain('Nothing changed');
    expect({ upstream: existsSync(b.upstreamFile), calls: b.calls() }).toEqual({ upstream: false, calls: ['systemctl cat isaflow.service'] });
    expect(() => cutover('', { CUTOVER_CONFIRM: 'yes' })).toThrow(/after hours only/);
  }, 30_000);

  it('cuts over: colour seeded from the live release (no env files), :80 then :3101 to nginx, old unit moved and masked', async () => {
    const { A } = await box();
    writeFileSync(b.path('stage', 'isaflow-combined.pre-bluegreen'), '# a stale backup from an earlier cutover/undo cycle');
    expect(cutover('', { CUTOVER_CONFIRM: 'yes' })).toContain('Cutover complete');
    const probe = readFileSync(b.env.BG_PROBE_FILE, 'utf8');
    expect({
      live: b.live(), site: site() === repoSite(), available: readFileSync(b.path('site-available'), 'utf8') === repoSite(),
      backup: readFileSync(b.path('stage', 'isaflow-combined.pre-bluegreen'), 'utf8') === TODAY,
      unitMoved: !existsSync(b.path('isaflow.service')) && existsSync(b.path('isaflow.service.pre')),
      marker: b.marker(A), envCopied: existsSync(b.path('rel', `isaflow-${A}`, '.env.local')),
      seeded: readFileSync(b.path('rel', `isaflow-${A}`, 'RELEASE_SHA'), 'utf8').trim(), chunk: existsSync(b.path('static', '_next/static/chunks/l.js')),
      token: /"[0-9a-f]{32}" \$upstream_addr;/.test(probe) && !probe.includes(Box.TOKEN), probeMode: (statSync(b.env.BG_PROBE_FILE).mode & 0o777).toString(8),
      order: b.calls().filter((c) => /isaflow\.service$/.test(c) && !/cat|is-active|show /.test(c)),
      staged: existsSync(b.path('site.new')),
    }).toEqual({
      live: `[${A}]`, site: true, available: true, backup: true, unitMoved: true, marker: null, envCopied: false, seeded: 'live-sha', chunk: true,
      token: true, probeMode: '600', order: ['systemctl disable --now isaflow.service', 'systemctl mask isaflow.service'], staged: false,
    });
  }, 60_000);

  it('a colour that fails verification, or lacks a property isaflow.service had, never takes traffic', async () => {
    const { A } = await box();
    expect(() => cutover('', { CUTOVER_CONFIRM: 'yes', BG_VERIFY: 'false' })).toThrow(/failed verification. Nothing switched/);
    expect({ upstream: existsSync(b.upstreamFile), site: site() === TODAY, stopped: b.calls().includes(`systemctl disable --now isaflow@${A}`) })
      .toEqual({ upstream: false, site: true, stopped: true });
    b.wrapSystemctl(`  "show "*isaflow.service) echo "OOMScoreAdjust=-500";;\n  "show "*) echo "OOMScoreAdjust=0";;`);
    expect(() => cutover('', { CUTOVER_CONFIRM: 'yes' })).toThrow(/differs from isaflow.service[\s\S]*Nothing switched/);
    expect(existsSync(b.upstreamFile)).toBe(false);
  }, 60_000);

  it('waits for running cron units before :3101 changes hands, and gives up without touching it', async () => {
    await box();
    // wal-archive runs for ever and never touches :3101: it must not block. dunning-send curls :3101: it must.
    b.wrapSystemctl(`  "list-units "*) printf 'isaflow-wal-archive.service loaded active running\\nisaflow-dunning-send.service loaded activating start\\n';;
  "cat isaflow-dunning-send.service") echo "ExecStart=/usr/bin/curl http://127.0.0.1:3101/api/cron/dunning-send";;
  "cat isaflow-wal-archive.service") echo "ExecStart=/opt/isaflow-ops/wal-archive-isaflow.sh";;`);
    expect(() => cutover('', { CUTOVER_CONFIRM: 'yes', CUTOVER_CRON_TRIES: '1' })).toThrow(/cron units still running: isaflow-dunning-send.service$/m);
    expect({ oldRunning: existsSync(b.path('old-active')), unitInPlace: existsSync(b.path('isaflow.service')) }).toEqual({ oldRunning: true, unitInPlace: true });
  }, 60_000);

  it('a permanent daemon (isaflow-wal-archive) does not block the cutover', async () => {
    await box();
    b.wrapSystemctl(`  "list-units "*) echo "isaflow-wal-archive.service loaded active running";;
  "cat isaflow-wal-archive.service") echo "ExecStart=/opt/isaflow-ops/wal-archive-isaflow.sh";;`);
    expect(cutover('', { CUTOVER_CONFIRM: 'yes', CUTOVER_CRON_TRIES: '1' })).toContain('Cutover complete');
  }, 60_000);

  it('if nginx cannot take :3101, isaflow.service is put straight back and the old unit stays where it was', async () => {
    await box();
    expect(() => cutover('', { CUTOVER_CONFIRM: 'yes', NGINX_T_FAIL_IF: 'listen 3101' })).toThrow(/nginx could not take :3101; putting isaflow.service back/);
    expect({
      oldRunning: existsSync(b.path('old-active')), unitInPlace: existsSync(b.path('isaflow.service')),
      siteHas3101: /listen\s+3101/.test(site()), masked: b.calls().includes('systemctl mask isaflow.service'),
    }).toEqual({ oldRunning: true, unitInPlace: true, siteHas3101: false, masked: false });
  }, 90_000);

  it('a signal (dropped session) while :3101 changes hands also puts isaflow.service back', async () => {
    await box();
    expect(() => cutover('', { CUTOVER_CONFIRM: 'yes', NGINX_KILL_PARENT_IF: 'listen 3101' })).toThrow(/stopped inside recover_cutover_3101 \(exit 130\)/);
    expect({ oldRunning: existsSync(b.path('old-active')), unitInPlace: existsSync(b.path('isaflow.service')), siteHas3101: /listen\s+3101/.test(site()) })
      .toEqual({ oldRunning: true, unitInPlace: true, siteHas3101: false });
  }, 90_000);

  it('a second signal during the recovery does not stop it', async () => {
    await box();
    // First TERM inside the window; another on every reload after that (the recovery's own reloads).
    b.stub('nginx', `echo "nginx $*" >> "${b.root}/calls"
if [ "$1" = "-t" ] && grep -q "listen 3101" "$CUTOVER_SITE" 2>/dev/null && [ ! -f "${b.root}/killed" ]; then touch "${b.root}/killed"; kill -TERM $PPID; exit 0; fi
if [ "$1" = "-s" ] && [ -f "${b.root}/killed" ]; then kill -TERM $PPID; kill -INT $PPID; fi
exit 0`);
    expect(() => cutover('', { CUTOVER_CONFIRM: 'yes' })).toThrow(/stopped inside recover_cutover_3101/);
    expect({ oldRunning: existsSync(b.path('old-active')), unitInPlace: existsSync(b.path('isaflow.service')), siteHas3101: /listen\s+3101/.test(site()) })
      .toEqual({ oldRunning: true, unitInPlace: true, siteHas3101: false });
  }, 90_000);

  it('--undo after a full cutover, at 11:00, puts isaflow.service back on the live release and keeps every env file', async () => {
    const { A } = await box();
    writeFileSync(b.path('old', '.env.local.pre-s07b'), 'OLD=1');
    cutover('', { CUTOVER_CONFIRM: 'yes' });
    writeFileSync(b.path('rel', `isaflow-${A}`, 'server.js'), '// live colour');
    b.stub('date', 'case "$1" in +%u) echo 2;; +%H) echo 11;; esac');
    expect(cutover('--undo')).toContain('Undo complete');
    expect({
      site: site() === TODAY, available: readFileSync(b.path('site-available'), 'utf8') === TODAY, upstream: existsSync(b.upstreamFile),
      probe: existsSync(b.env.BG_PROBE_FILE), unit: existsSync(b.path('isaflow.service')), running: existsSync(b.path('old-active')),
      code: readFileSync(b.path('old', 'server.js'), 'utf8'), envKept: [existsSync(b.path('old', '.env.local')), existsSync(b.path('old', '.env.local.pre-s07b'))],
    }).toEqual({ site: true, available: true, upstream: false, probe: false, unit: true, running: true, code: '// live colour', envKept: [true, true] });
  }, 120_000);

  it('--undo whose isaflow.service does not come back gives :3101 back to nginx (and never mistakes nginx for it)', async () => {
    const { front } = await box();
    cutover('', { CUTOVER_CONFIRM: 'yes' });
    // :3101 answered by nginx (the front) instead of isaflow.service: the restore must not count that as success.
    expect(() => cutover('--undo', { CUTOVER_OLD_HEALTH: `http://127.0.0.1:${front}/api/health` }))
      .toThrow(/nginx, not isaflow.service, answers on :3101[\s\S]*nginx takes :3101 again/);
    expect({ siteIsNew: site() === repoSite(), oldRunning: existsSync(b.path('old-active')) }).toEqual({ siteIsNew: true, oldRunning: false });
  }, 120_000);

  it('--undo after a half-done cutover (isaflow.service still running) restores the old site and stops the colours', async () => {
    const { A } = await box();
    writeFileSync(b.path('stage', 'isaflow-combined.pre-bluegreen'), TODAY);
    writeFileSync(b.path('site'), repoSite());
    b.upstream(A);
    expect(cutover('--undo')).toContain('Undo complete');
    expect({ site: site() === TODAY, upstream: existsSync(b.upstreamFile), stopped: b.calls().includes(`systemctl disable --now isaflow@${A}`) })
      .toEqual({ site: true, upstream: false, stopped: true });
  }, 60_000);
});
