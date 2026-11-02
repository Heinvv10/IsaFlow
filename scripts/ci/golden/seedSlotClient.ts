/**
 * The HTTP side of slot seeding: logs in as the slot's golden user against a LOCAL dev server (the one `bun run dev`
 * starts from a checkout whose .env.local points at isaflow_dev), switches into the slot company, and hands seedSlot an
 * API that unwraps the app's envelope (over fetch: Playwright's request context does not run under bun). Only a local dev port is accepted: seeding drives the real write routes, so the server
 * decides which database is written, and a deployed host (or prod's next-server) must never be one of them.
 */
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { FetchContext, type FetchResponse } from './fetchContext';
import { loginGolden } from '../../../tests/e2e/golden-paths/helpers/goldenLogin';
import type { GoldenSlot } from '../../../tests/e2e/golden-paths/helpers/goldenSlot';
import { seedSlot, type SeedApi, type SeedReport } from './seedSlotData';

/** The dev/CI server ports the golden specs accept (tests/e2e/golden-paths/v-empty-states.spec.ts): never prod's next-server on :3101. */
const isDevPort = (port: string): boolean => /^\d+$/.test(port) && ((Number(port) >= 3200 && Number(port) <= 3239) || (Number(port) >= 3300 && Number(port) <= 3799));

export function assertLocalBaseUrl(baseUrl: string): void {
  let host = '';
  let port = '';
  try { ({ hostname: host, port } = new URL(baseUrl)); } catch { throw new Error('the seed url does not parse'); }
  if (host !== 'localhost' && host !== '127.0.0.1') throw new Error(`refusing to seed through ${host}: only a local dev server on isaflow_dev may be seeded`);
  if (!isDevPort(port)) throw new Error(`refusing to seed through port ${port || '(default)'}: only a dev server on 3200-3239 or 3300-3799 may be seeded (production's next-server is on :3101)`);
}

/** The members of FetchContext the seeder uses; a test passes a fake. */
export interface SeedContext extends Pick<FetchContext, 'get' | 'post' | 'storageState'> {}

async function unwrap<T>(method: string, path: string, res: FetchResponse): Promise<T> {
  const body = await res.json().catch(async () => ({ nonJson: await res.text() }));
  if (res.status() < 200 || res.status() >= 300 || body?.success === false) {
    throw new Error(`${method} ${path} -> ${res.status()}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return (body?.data ?? body) as T;
}

/**
 * Logs `ctx` in as the slot's user and seeds. loginGolden switches into the slot company and reads the active company
 * back, throwing on any other, so no write below runs in a company that is not the slot's.
 */
export async function seedThroughContext(ctx: SeedContext, slot: GoldenSlot): Promise<SeedReport> {
  // loginGolden needs only get/post/storageState (see fetchContext.ts).
  await loginGolden(ctx as unknown as APIRequestContext, slot);
  const csrf = (await ctx.storageState()).cookies.find((c) => c.name === 'isaflow_csrf')?.value ?? '';
  const api: SeedApi = {
    get: async (path) => unwrap('GET', path, await ctx.get(path)),
    post: async (path, body) => unwrap('POST', path, await ctx.post(path, { data: body, headers: { 'x-csrf-token': csrf } })),
  };
  return seedSlot(api, randomUUID);
}

export async function seedSlotViaApp(baseUrl: string, slot: GoldenSlot): Promise<SeedReport> {
  assertLocalBaseUrl(baseUrl);
  return seedThroughContext(new FetchContext(baseUrl), slot);
}
