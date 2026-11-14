/**
 * A scripted SMTP server on 127.0.0.1 (a port the OS hands out) for sendEmail's transport tests. The real
 * nodemailer talks to it over real sockets; nothing leaves the machine.
 *
 * TLS modes: 'implicit' is TLS from the first byte (what port 465 speaks); 'starttls' is plaintext that offers
 * STARTTLS in its EHLO reply and upgrades on it; 'none' is plaintext that offers no STARTTLS (and refuses it).
 * The certificate is a throwaway self-signed one for 127.0.0.1 (`makeTestCert`); `watchClientSockets` makes the
 * client trust it (verification stays on: the test CA is added, nothing is switched off), can redirect a port
 * the test cannot bind (465) to the fake server, and records every client socket so a test can see it destroyed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { vi } from 'vitest';

export interface TestCert { key: string; cert: string }

/** A self-signed certificate for IP 127.0.0.1, valid one day. The temp dir holding its key is removed. */
export function makeTestCert(): TestCert {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-smtp-cert-'));
  try {
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' });
    return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The steps a test can script a reply for; 'end' is the reply to the end of DATA. */
export type SmtpStep = 'ehlo' | 'auth' | 'mail' | 'rcpt' | 'data' | 'end';

export interface FakeSmtpOptions {
  tls: 'implicit' | 'starttls' | 'none';
  cert?: TestCert;
  /** Accept the connection (and, for 'implicit', the handshake) and never send a byte. */
  silent?: boolean;
  /** Delay before every reply, ms. */
  delayMs?: number;
  /** A reply for a step instead of the default; 'drop' closes the connection without one. */
  reply?: (step: SmtpStep) => string | undefined;
}

export interface FakeSmtp {
  port: number;
  /** Every command line received, and whether it arrived over TLS. */
  lines: { line: string; secure: boolean }[];
  /** TLS handshakes completed / failed (a client speaking plaintext to an implicit-TLS port fails one). */
  handshakes: number;
  tlsErrors: number;
  /** Connections the client closed or that were otherwise torn down. */
  closed: number;
  /** Messages whose end of DATA arrived. */
  accepted: number;
  close(): Promise<void>;
}

export async function startFakeSmtp(o: FakeSmtpOptions): Promise<FakeSmtp> {
  if (o.tls !== 'none' && !o.cert) throw new Error('fakeSmtp: a TLS mode needs a cert');
  const sockets = new Set<net.Socket>();
  const state: FakeSmtp = { port: 0, lines: [], handshakes: 0, tlsErrors: 0, closed: 0, accepted: 0, close: async () => undefined };

  const track = (s: net.Socket) => {
    sockets.add(s);
    s.on('error', () => undefined);
    s.once('close', () => { state.closed += 1; sockets.delete(s); });
  };

  const session = (raw: net.Socket, startsSecure: boolean) => {
    let sock = raw;
    let secure = startsSecure;
    let inData = false;
    let buffer = '';
    const later = (fn: () => void) => (o.delayMs ? setTimeout(fn, o.delayMs) : fn());
    const write = (text: string) => later(() => { if (!sock.destroyed) sock.write(`${text}\r\n`); });
    const say = (step: SmtpStep, fallback: string) => {
      const r = o.reply?.(step) ?? fallback;
      if (r === 'drop') sock.destroy(); else write(r);
    };
    const ehlo = () => {
      const ext = [...(o.tls === 'starttls' && !secure ? ['STARTTLS'] : []), 'AUTH PLAIN'];
      const all = ['fake.test', ...ext];
      say('ehlo', all.map((l, i) => `250${i === all.length - 1 ? ' ' : '-'}${l}`).join('\r\n'));
    };
    const upgrade = () => later(() => {
      if (sock.destroyed) return;
      sock.removeListener('data', onData);
      sock.write('220 2.0.0 ready for TLS\r\n');
      const t = new tls.TLSSocket(raw, { isServer: true, key: o.cert!.key, cert: o.cert!.cert });
      t.once('secure', () => { state.handshakes += 1; secure = true; });
      t.on('error', () => { state.tlsErrors += 1; });
      buffer = '';
      sock = t;
      t.on('data', onData);
    });
    function onData(chunk: Buffer): void {
      buffer += chunk.toString('utf8');
      if (inData) {
        if (!buffer.includes('\r\n.\r\n')) return;
        inData = false;
        buffer = '';
        state.accepted += 1;
        say('end', '250 queued');
        return;
      }
      let at: number;
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        state.lines.push({ line, secure });
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) ehlo();
        else if (cmd === 'STARTTLS') {
          if (o.tls === 'starttls' && !secure) { upgrade(); return; }
          write('502 5.5.1 STARTTLS not offered');
        } else if (cmd.startsWith('AUTH')) say('auth', '235 ok');
        else if (cmd.startsWith('MAIL')) say('mail', '250 ok');
        else if (cmd.startsWith('RCPT')) say('rcpt', '250 ok');
        else if (cmd === 'DATA') { inData = !o.reply?.('data'); say('data', '354 go on'); }
        else if (cmd === 'QUIT') { write('221 bye'); later(() => sock.end()); }
        else write('502 5.5.2 unknown');
      }
    }
    if (o.silent) return;
    sock.on('data', onData);
    write('220 fake.test ESMTP');
  };

  const server: net.Server = o.tls === 'implicit'
    ? tls.createServer({ key: o.cert!.key, cert: o.cert!.cert }, (s) => { state.handshakes += 1; session(s, true); })
    : net.createServer((s) => session(s, false));
  server.on('connection', track);
  server.on('tlsClientError', () => { state.tlsErrors += 1; });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = () => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

export interface ClientSocketWatch {
  /** Every socket the client called connect() on (plain or TLS). */
  sockets: net.Socket[];
  /** TLS sockets the client opened (tls.connect). */
  tlsSockets: tls.TLSSocket[];
  restore(): void;
}

/**
 * Spies on the client side: tls.connect gets `ca` (the test cert; verification stays on) and every
 * net.Socket#connect to `redirect.from` dials `redirect.to` instead. Restore it in afterEach.
 */
export function watchClientSockets(opts: { ca?: string; redirect?: { from: number; to: number } } = {}): ClientSocketWatch {
  const watch: ClientSocketWatch = { sockets: [], tlsSockets: [], restore: () => undefined };
  const realTls = tls.connect;
  const realConnect = net.Socket.prototype.connect;
  const tlsSpy = vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions, cb?: () => void) => {
    if (typeof options !== 'object' || options === null) throw new Error('watchClientSockets: tls.connect(options) form only');
    const s = realTls.call(tls, opts.ca ? { ...options, ca: opts.ca } : options, cb);
    watch.tlsSockets.push(s);
    return s;
  }) as typeof tls.connect);
  const rewrite = (v: unknown): unknown => {
    if (!opts.redirect) return v;
    if (v === opts.redirect.from) return opts.redirect.to;
    if (v && typeof v === 'object' && !Array.isArray(v) && (v as { port?: unknown }).port === opts.redirect.from) {
      return { ...(v as object), port: opts.redirect.to };
    }
    return v;
  };
  const connectSpy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    watch.sockets.push(this);
    // net.connect hands connect() its normalized [options, cb] array, tagged with a private symbol: edit it in place.
    if (Array.isArray(args[0])) args[0][0] = rewrite(args[0][0]);
    else args[0] = rewrite(args[0]);
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  });
  watch.restore = () => { tlsSpy.mockRestore(); connectSpy.mockRestore(); };
  return watch;
}
