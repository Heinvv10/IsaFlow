/**
 * The repo's nginx site config (scripts/nginx/isaflow-combined), run in a real user-mode nginx on loopback ports with
 * two colour stand-ins that echo what they received: the probe header, the :3101 pass-through, the shared static
 * folder with its fallback to the app, and a switch through bg_switch. Skipped where nginx is not installed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Box } from './blueGreenHarness';

const NGINX = '/usr/sbin/nginx';
const b = existsSync(NGINX) ? new Box() : null;
let p80 = 0;
let p3101 = 0;
let A = 0;
let B = 0;

const curl = (url: string, headers: string[] = []) => {
  const out = execFileSync('curl', ['-s', '-i', ...headers.flatMap((h) => ['-H', h]), url], { encoding: 'utf8' });
  const [head, ...body] = out.split('\r\n\r\n');
  const header = (name: string) => new RegExp(`^${name}: (.*)$`, 'im').exec(head)?.[1]?.trim() ?? null;
  return { status: Number(/^HTTP\/[\d.]+ (\d+)/.exec(head)?.[1]), header, body: body.join('\r\n\r\n') };
};

// The CI runner is this box, which has nginx: there, a missing nginx is a failure, not a skip.
it.runIf(!b && process.env.GITHUB_ACTIONS === 'true')('nginx is installed where CI runs', () => {
  expect(existsSync(NGINX)).toBe(true);
});

describe.skipIf(!b)('the site config in a real nginx', () => {
  beforeAll(async () => {
    const box = b!;
    [p80, p3101] = [await box.freePort(), await box.freePort()];
    [A, B] = [await box.echoColour('A'), await box.echoColour('B')];
    const n = box.path('nginx');
    for (const d of ['logs', 'run', 'conf.d']) mkdirSync(join(n, d), { recursive: true });
    mkdirSync(box.path('static', '_next/static/chunks'), { recursive: true });
    writeFileSync(box.path('static', '_next/static/chunks/old.js'), 'old chunk');
    writeFileSync(join(n, 'site.conf'), readFileSync('scripts/nginx/isaflow-combined', 'utf8')
      .replace('listen 80;', `listen 127.0.0.1:${p80};`).replace('listen 3101;', `listen 127.0.0.1:${p3101};`)
      .replaceAll('root /home/velo/isaflow-static;', `root ${box.path('static')};`));
    writeFileSync(join(n, 'nginx.conf'), `worker_processes 1; pid ${n}/run/nginx.pid; error_log ${n}/logs/error.log;
events { worker_connections 64; }
http { include /etc/nginx/mime.types; access_log off;
  client_body_temp_path ${n}/run/b; proxy_temp_path ${n}/run/p; fastcgi_temp_path ${n}/run/f; uwsgi_temp_path ${n}/run/u; scgi_temp_path ${n}/run/s;
  include ${box.env.BG_PROBE_FILE}; include ${box.upstreamFile}; include ${n}/site.conf; }\n`);
    box.stub('nginxctl', `exec ${NGINX} -p "${n}" -c "${n}/nginx.conf" "$@"`);
    box.env.BG_NGINX = box.path('bin', 'nginxctl');
    box.env.BG_PORTS = `${A} ${B}`;
    box.run(`bg_probe_conf ${Box.TOKEN} > "$BG_PROBE_FILE"`);   // the exact file cutover.sh installs
    box.upstream(A);
    box.bash('"$BG_NGINX"');
  }, 30_000);
  afterAll(() => { if (b) { b.bash('"$BG_NGINX" -s quit || true'); b.dispose(); } });

  it('names the colour only to a request carrying the probe token', () => {
    const plain = curl(`http://127.0.0.1:${p80}/api/health`, ['Host: app.isaflow.co.za']);
    const wrong = curl(`http://127.0.0.1:${p80}/api/health`, ['Host: app.isaflow.co.za', 'X-IsaFlow-Probe: 1']);
    const probed = curl(`http://127.0.0.1:${p80}/api/health`, ['Host: app.isaflow.co.za', `X-IsaFlow-Probe: ${Box.TOKEN}`]);
    expect([plain.status, plain.header('X-IsaFlow-Upstream'), wrong.header('X-IsaFlow-Upstream'), probed.header('X-IsaFlow-Upstream')])
      .toEqual([200, null, null, `127.0.0.1:${A}`]);
  });

  it(':3101 passes the request through as sent: Host and X-Forwarded-For unchanged', () => {
    const r = curl(`http://127.0.0.1:${p3101}/api/x`, ['Host: admin.isaflow.co.za', 'X-Forwarded-For: 203.0.113.7']);
    expect(JSON.parse(r.body)).toEqual({ colour: 'A', host: 'admin.isaflow.co.za', xff: '203.0.113.7' });
  });

  it('serves a kept chunk from the shared folder (immutable), and falls back to the app for one it lacks', () => {
    const kept = curl(`http://127.0.0.1:${p80}/_next/static/chunks/old.js`, ['Host: app.isaflow.co.za']);
    const missing = curl(`http://127.0.0.1:${p3101}/_next/static/chunks/new.js`);
    expect({ kept: [kept.status, kept.body, kept.header('Cache-Control')], fallback: JSON.parse(missing.body).colour })
      .toEqual({ kept: [200, 'old chunk', 'public, max-age=31536000, immutable'], fallback: 'A' });
  });

  it('bg_switch moves both fronts to the other colour with a reload', () => {
    b!.run(`bg_switch ${B}; ok=0; for i in $(seq 1 100); do
  if curl -s -o /dev/null -H "X-IsaFlow-Probe: ${Box.TOKEN}" -w '%header{x-isaflow-upstream}' http://127.0.0.1:${p3101}/api/health | grep -q ":${B}$"; then ok=$((ok+1)); else ok=0; fi
  [ "$ok" -ge 5 ] && break; sleep 0.1; done`);   // an old worker may answer once or twice right after the reload
    const probed = curl(`http://127.0.0.1:${p3101}/api/health`, [`X-IsaFlow-Probe: ${Box.TOKEN}`]);
    const viaPort80 = JSON.parse(curl(`http://127.0.0.1:${p80}/api/x`, ['Host: app.isaflow.co.za']).body).colour;
    expect([probed.header('X-IsaFlow-Upstream'), viaPort80]).toEqual([`127.0.0.1:${B}`, 'B']);
  });
});
