/**
 * R-176 — cancelBackend on a real, connected node-postgres client. The unit suite checks the
 * packet against a plain listener; this checks what a real connection carries (processID a
 * number, secretKey a number or a Buffer) and that the cancel stops its statement. A pg release
 * that changes those fields makes cancelBackend return false, and this fails.
 */
import { afterAll, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { backendState } from './r176-evict.helpers';
import { cancelBackend } from '@/lib/cancelBackend';

assertDisposable();
const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
afterAll(() => admin.end());

it('a connected client: its key fields have the types the cancel reads, and the cancel stops its statement', async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  client.on('error', () => undefined);
  await client.connect();
  try {
    const fields = client as unknown as { processID: unknown; secretKey: unknown };
    expect(typeof fields.processID).toBe('number');
    expect(typeof fields.secretKey === 'number' || Buffer.isBuffer(fields.secretKey)).toBe(true);
    const running = client.query('SELECT pg_sleep(30)').then(() => 'completed', (e: { code?: string }) => e.code);
    const pid = fields.processID as number;
    for (let i = 0; i < 80; i += 1) {
      const r = await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND state = 'active'", [pid]);
      if (r.rowCount) break;
      await new Promise((done) => setTimeout(done, 25));
    }
    expect(cancelBackend(client)).toBe(true);
    expect(await running).toBe('57014'); // canceling statement due to user request
    expect(await backendState(admin, pid, 'idle')).toBe('idle'); // the connection itself survives a cancel
  } finally {
    await client.end();
  }
}, 15000);
