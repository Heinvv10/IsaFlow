/**
 * node:fs for the CLI end tests (sageCliEndHarness.ts), the --report writes faulted as `h.reportFault` / `h.truncFault` say (a failing disk). Its
 * own module, importing no fs itself: the harness imports node:fs, so a factory that imported the harness would wait on itself.
 */
import type { H } from './sageCliEndHarness';

/** fs with the report's writes faulted as `h.reportFault` says (B31-2: a failing disk); every report body has a "status". */
export function fsMock(real: typeof import('node:fs')) {
  const writeSync = ((fd: number, buf: unknown, ...rest: unknown[]) => {
    const write = real.writeSync as (...x: unknown[]) => number;
    const h = (globalThis as { __sageCliEnd?: H }).__sageCliEnd; // read at each call: this mock may load before the harness
    if (h === undefined || !Buffer.isBuffer(buf) || !buf.includes('"status": ')) return write(fd, buf, ...rest);
    const [offset] = rest as [number];
    if (offset === 0) { h.reportWrites++; h.halfDone = false; } // a body starts at its first byte
    const fault = h.reportFault(h.reportWrites);
    if (fault === 'EIO' || (fault === 'half' && h.halfDone)) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
    if (fault === 'half') { h.halfDone = true; const half = Math.floor(buf.length / 2); return write(fd, buf, 0, half, 0); }
    return write(fd, buf, ...rest);
  }) as typeof real.writeSync;
  const ftruncateSync = ((fd: number, len?: number) => {
    const h = (globalThis as { __sageCliEnd?: H }).__sageCliEnd;
    if (h?.truncFault(h.reportWrites)) { // only the report truncates
      h.fstatArmed = h.fstatFault;
      throw Object.assign(new Error('EIO: injected ftruncate'), { code: 'EIO' });
    }
    return real.ftruncateSync(fd, len);
  }) as typeof real.ftruncateSync;
  const fstatSync = ((...a: unknown[]) => {
    const h = (globalThis as { __sageCliEnd?: H }).__sageCliEnd;
    if (h?.fstatArmed) { h.fstatArmed = false; throw Object.assign(new Error('EIO: injected fstat'), { code: 'EIO' }); } // the one after it only
    return (real.fstatSync as (...x: unknown[]) => unknown)(...a);
  }) as typeof real.fstatSync;
  return { ...real, default: { ...real, writeSync, ftruncateSync, fstatSync }, writeSync, ftruncateSync, fstatSync };
}
