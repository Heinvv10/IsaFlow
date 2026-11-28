/**
 * R39r-5 (round 39): the generic reader of thrown values lives in src/lib/thrownValue.ts with no driver import, and the lib callers
 * (registry.ts, afterCommit.ts) use it; the Sage migration adds pg's DatabaseError marker in its own module (sageTold.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { snapshot, told, UNREADABLE } from '@/lib/thrownValue';
import { fromServer, snapshot as sageSnapshot } from '@/modules/accounting/services/sage-migration/sageTold';

const ROOT = join(__dirname, '../../..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

describe('R39r-5: thrownValue.ts', () => {
  it('imports no driver (no pg, no module import at all)', () => {
    expect(read('src/lib/thrownValue.ts')).not.toMatch(/^\s*import\b|require\(/m);
  });
  it('registry.ts and afterCommit.ts read thrown values through @/lib/thrownValue, never through the Sage module', () => {
    for (const f of ['src/lib/mcp/registry.ts', 'src/lib/afterCommit.ts']) {
      expect(read(f)).toMatch(/from '@\/lib\/thrownValue'/);
      expect(read(f)).not.toMatch(/sage-migration/);
    }
  });
  it('a generic snapshot reads a hostile value without a throw; only the Sage snapshot marks the server\'s answer', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('injected'); }, getPrototypeOf: () => { throw new Error('injected'); } });
    expect(told(hostile)).toBe(UNREADABLE);
    expect(snapshot(hostile).message).toBe(UNREADABLE);
    const dbErr = Object.assign(new pg.DatabaseError('terminating connection', 1, 'error'), { code: '57P01' });
    expect(fromServer(snapshot(dbErr))).toBe(false);
    expect(fromServer(sageSnapshot(dbErr))).toBe(true);
    expect(sageSnapshot(dbErr)).toMatchObject({ message: 'terminating connection', code: '57P01' });
  });
});
