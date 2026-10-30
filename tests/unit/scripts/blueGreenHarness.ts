/**
 * Scratch box for the blue/green deploy tests: a temp folder standing in for /home/velo and /etc/nginx, stub
 * nginx/systemctl on PATH that log their calls, and node HTTP servers standing in for the colours and for nginx.
 * The nginx stand-in reads the upstream file on every request, so it answers from whichever colour the file names,
 * as nginx does after a reload.
 */
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { createServer, type AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

export const LIB = join(process.cwd(), 'scripts', 'deploy', 'bluegreen.sh');

export class Box {
  static readonly TOKEN = 'probetokenfortests';
  readonly root = mkdtempSync(join(tmpdir(), 'bluegreen-'));
  private servers: ChildProcess[] = [];
  env: Record<string, string>;

  constructor() {
    for (const d of ['bin', 'conf.d', 'envhome', 'rel']) mkdirSync(join(this.root, d));
    this.stub('nginx', `echo "nginx $*" >> "${this.root}/calls"
[ "$1" = "-t" ] && [ -n "$NGINX_KILL_PARENT_IF" ] && grep -q "$NGINX_KILL_PARENT_IF" "$CUTOVER_SITE" 2>/dev/null && { kill -TERM $PPID; exit 0; }
[ "$1" = "-t" ] && { [ -n "$NGINX_T_FAIL_IF" ] && grep -q "$NGINX_T_FAIL_IF" "$CUTOVER_SITE" 2>/dev/null && exit 1; exit "\${NGINX_T_RC:-0}"; }
[ "$1" = "-s" ] && exit "\${NGINX_RELOAD_RC:-0}"; exit 0`);
    // systemctl: logs. isaflow.service is "active" while $root/old-active exists. A colour isaflow@P is a node
    // process whose pid is in $root/pid-P: stop/disable --now kill it, restart replaces it.
    this.stub('systemctl', `echo "systemctl $*" >> "${this.root}/calls"
kill_colour() { [ -f "${this.root}/pid-$1" ] && { kill "$(cat "${this.root}/pid-$1")" 2>/dev/null; rm -f "${this.root}/pid-$1"; sleep 0.3; }; true; }
case "$*" in
  "is-active --quiet isaflow.service") [ -f "${this.root}/old-active" ];;
  "disable --now isaflow.service") rm -f "${this.root}/old-active";;
  "enable --now isaflow.service") touch "${this.root}/old-active";;
  "cat isaflow.service") echo "# /etc/systemd/system/isaflow.service";;
  "is-active --quiet isaflow@"*) [ -f "${this.root}/pid-\${3#isaflow@}" ];;
  "stop isaflow@"*) kill_colour "\${2#isaflow@}";;
  "disable --now isaflow@"*) kill_colour "\${3#isaflow@}";;
  "restart isaflow@"*) port=\${2#isaflow@}; kill_colour "$port"
    nohup "${process.execPath}" -e "require('http').createServer((q,s)=>s.end('ok')).listen($port,'127.0.0.1')" >/dev/null 2>&1 8>&- 9>&- &
    echo $! > "${this.root}/pid-$port"; sleep 0.5;;
esac`);
    this.env = {
      PATH: `${join(this.root, 'bin')}:${process.env.PATH}`, HOME: this.root, BG_SUDO: '', BG_OWNER: `${process.getuid!()}`,
      BG_RELEASE_ROOT: join(this.root, 'rel'), BG_STATIC_ROOT: join(this.root, 'static'), BG_ENV_HOME: join(this.root, 'envhome'),
      BG_UPSTREAM_FILE: this.upstreamFile, BG_LOCK_FILE: join(this.root, 'colours.lock'),
      BG_UNIT_FILE: join(this.root, 'isaflow@.service'), BG_KEEP_BUILDS: '2', BG_HEALTH_TRIES: '2', BG_DRAIN_SECS: '1',
      BG_BUN: join(this.root, 'bin', 'bun'), BG_PROBE_FILE: join(this.root, 'conf.d', 'isaflow-probe.conf'),
    };
    writeFileSync(this.env.BG_PROBE_FILE, `map $http_x_isaflow_probe $isaflow_upstream_probe {\n    "${Box.TOKEN}" $upstream_addr;\n    default "";\n}\n`);
  }

  get upstreamFile() { return join(this.root, 'conf.d', 'isaflow-live.conf'); }
  path(...p: string[]) { return join(this.root, ...p); }

  stub(name: string, body: string) {
    const p = join(this.root, 'bin', name);
    writeFileSync(p, `#!/bin/bash\n${body}\n`);
    chmodSync(p, 0o755);
  }

  /** Replaces the stub systemctl with `cases` (bash case arms) in front of the standard stub. */
  wrapSystemctl(cases: string) {
    const bin = join(this.root, 'bin');
    if (!existsSync(join(bin, 'systemctl-base'))) writeFileSync(join(bin, 'systemctl-base'), readFileSync(join(bin, 'systemctl')), { mode: 0o755 });
    this.stub('systemctl', `case "$*" in\n${cases}\nesac\nexec "${join(bin, 'systemctl-base')}" "$@"`);
  }

  /** Runs a bash command (stderr folded into stdout); returns the output, or throws an Error whose message is it. */
  bash(cmd: string, env: Record<string, string> = {}) {
    try {
      return execFileSync('bash', ['-c', `{ ${cmd}\n} 2>&1`], { encoding: 'utf8', cwd: process.cwd(), env: { ...this.env, ...env } });
    } catch (e) {
      throw new Error(String((e as { stdout?: string }).stdout ?? e));
    }
  }

  /** Runs `script` under set -e after sourcing the library. */
  run(script: string, env: Record<string, string> = {}) { return this.bash(`set -e\n. "${LIB}"\n${script}`, env); }

  upstream(port: number | string) { writeFileSync(this.upstreamFile, `upstream isaflow_live {\n    server 127.0.0.1:${port};\n}\n`); }
  live() { return this.run('echo "[$(bg_live_port)]"').trim(); }
  calls() { return existsSync(this.path('calls')) ? readFileSync(this.path('calls'), 'utf8').trim().split('\n') : []; }
  marker(port: number | string) {
    const f = this.path('rel', `isaflow-${port}.unverified`);
    return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
  }

  release(port: number | string, sha: string, unverified?: string) {
    const dir = this.path('rel', `isaflow-${port}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'server.js'), `// ${sha}`);
    writeFileSync(join(dir, 'RELEASE_SHA'), `${sha}\n`);
    if (unverified) writeFileSync(this.path('rel', `isaflow-${port}.unverified`), `${unverified}\n`);
  }

  /** A fake built repo whose .next/static holds `files` under build id `id` (plus the unit template). */
  build(id: string, files: string[]) {
    const repo = this.path(`repo-${id}`);
    mkdirSync(join(repo, '.next/static'), { recursive: true });
    for (const f of files) { mkdirSync(join(repo, '.next/static', f, '..'), { recursive: true }); writeFileSync(join(repo, '.next/static', f), f); }
    mkdirSync(join(repo, '.next/standalone'), { recursive: true });
    writeFileSync(join(repo, '.next/standalone/server.js'), `// ${id}`);
    mkdirSync(join(repo, 'public'), { recursive: true });
    writeFileSync(join(repo, 'public/sw.js'), 'const V = "__BUILD_ID__";');
    writeFileSync(join(repo, '.next/BUILD_ID'), id);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts/isaflow@.service'), `# unit for ${id}`);
    return repo;
  }

  /** A running colour stand-in (200 on every path) that the stub systemctl can stop and restart. Resolves its port. */
  async colour(): Promise<number> {
    const port = await this.freePort();
    this.bash(`nohup "${process.execPath}" -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')" >/dev/null 2>&1 &
echo $! > "${this.root}/pid-${port}"; for i in $(seq 1 50); do curl -sf "http://127.0.0.1:${port}/" >/dev/null && break; sleep 0.1; done`);
    return port;
  }

  /** nginx stand-in: to a request carrying the probe token, X-IsaFlow-Upstream names the port in the upstream file (or `fixed`). */
  front(fixed = ''): Promise<number> {
    const probe = JSON.stringify(this.env.BG_PROBE_FILE);
    const probed = `((/"([A-Za-z0-9]+)"\\s+\\$upstream_addr/.exec(require('fs').existsSync(${probe}) ? require('fs').readFileSync(${probe}, 'utf8') : '') || [])[1] || '-none-') === q.headers['x-isaflow-probe']`;
    return this.spawnServer(fixed
      ? `if (${probed}) s.setHeader('x-isaflow-upstream', ${JSON.stringify(fixed)});`
      : `const m = /127\\.0\\.0\\.1:(\\d+)/.exec(require('fs').readFileSync(${JSON.stringify(this.upstreamFile)}, 'utf8') || '');
         if (m && ${probed}) s.setHeader('x-isaflow-upstream', '127.0.0.1:' + m[1]);`);
  }

  /** A colour stand-in that answers with what it received: its name, the Host and X-Forwarded-For headers. */
  echoColour(name: string): Promise<number> {
    return this.spawnServer(`s.setHeader('content-type', 'application/json');
      s.end(JSON.stringify({ colour: ${JSON.stringify(name)}, host: q.headers.host, xff: q.headers['x-forwarded-for'] ?? null })); return;`);
  }

  /** nginx :80 stand-in: like front(), but drops any request not for Host app.isaflow.co.za (as this box's default server does). */
  front80(): Promise<number> {
    return this.front().then(async (inner) => this.spawnServer(`if (q.headers.host !== 'app.isaflow.co.za') { s.destroy(); return; }
      return require('http').get({ host: '127.0.0.1', port: ${inner}, path: q.url, headers: q.headers }, (r) => { s.writeHead(r.statusCode, r.headers); r.pipe(s); });`));
  }

  /** isaflow.service stand-in: 200 only while the stub systemctl has it active ($root/old-active), else 503. */
  oldService(): Promise<number> {
    return this.spawnServer(`if (!require('fs').existsSync(${JSON.stringify(this.path('old-active'))})) s.statusCode = 503;`);
  }

  private spawnServer(handler: string): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', `require('http').createServer((q, s) => { try { ${handler} } catch {}
        s.end('{"status":"ok"}'); }).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`]);
      this.servers.push(child);
      child.stdout!.once('data', (d) => resolve(Number(String(d).trim())));
    });
  }

  /** A port nothing listens on (bound and released). */
  freePort(): Promise<number> {
    return new Promise((resolve) => {
      const srv = createServer().listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as AddressInfo;
        srv.close(() => resolve(port));
      });
    });
  }

  dispose() {
    for (const s of this.servers) s.kill();
    for (const f of readdirSync(this.root).filter((n) => n.startsWith('pid-'))) {
      try { process.kill(Number(readFileSync(this.path(f), 'utf8'))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}
