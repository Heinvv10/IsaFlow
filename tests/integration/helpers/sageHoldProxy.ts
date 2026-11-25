/**
 * A TCP proxy between the CLI and PostgreSQL that models network timing (round-22 breaker harness, holdproxy.ts): nothing in the app is
 * patched. On the first connection whose client sent `p1` and then (the `nth` time overall) `p2`, every server -> client byte from then on
 * is held for `holdMs` and flushed in ONE write (the server's FIN after it), so a FATAL the server sends in that window reaches the client
 * in the same chunk as the answer to the `p2` query. `onHold` is called when the hold starts (the test kills the backend then).
 */
import net from 'node:net';

export interface HoldProxy { port: number; held: Promise<void>; close: () => Promise<void> }

export async function holdProxy(o: { upstreamPort: number; p1: string; p2: string; nth?: number; holdMs?: number }): Promise<HoldProxy> {
  let used = false;
  let nth = o.nth ?? 1;
  let onHeld: () => void = () => undefined;
  const held = new Promise<void>((r) => { onHeld = r; });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((c) => {
    let seen1 = false;
    let holding = false;
    let chunks: Buffer[] = [];
    let upEnded = false;
    const s = net.connect(o.upstreamPort, '127.0.0.1');
    for (const x of [c, s]) { sockets.add(x); x.on('close', () => sockets.delete(x)); x.on('error', () => x.destroy()); }
    c.on('data', (d) => {
      const t = d.toString('latin1');
      if (!used && !seen1 && t.includes(o.p1)) seen1 = true;
      else if (!used && seen1 && t.includes(o.p2) && --nth === 0) {
        used = true;
        holding = true;
        onHeld();
        setTimeout(() => {
          const all = Buffer.concat(chunks);
          [chunks, holding] = [[], false];
          c.write(all, () => { if (upEnded) c.end(); });
        }, o.holdMs ?? 1500);
      }
      s.write(d);
    });
    s.on('data', (d) => { if (holding) chunks.push(d); else c.write(d); });
    s.on('end', () => { upEnded = true; if (!holding) c.end(); });
    c.on('end', () => s.end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return { port, held, close: async () => { for (const x of sockets) x.destroy(); await new Promise<void>((r) => server.close(() => r())); } };
}
