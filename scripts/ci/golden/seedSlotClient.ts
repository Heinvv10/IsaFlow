/**
 * The HTTP side of slot seeding: logs in as the slot's golden user against a LOCAL dev server (the one `bun run dev`
 * starts from a checkout whose .env.local points at isaflow_dev), switches into the slot company, and hands seedSlot an
 * API that unwraps the app's envelope (over fetch: Playwright's request context does not run under bun). Only localhost is accepted: seeding drives the real write routes, so the server
 * decides which database is written, and a deployed host must never be one of them.
 */
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { FetchContext, type FetchResponse } from './fetchContext';
import { loginGolden } from '../../../tests/e2e/golden-paths/helpers/goldenLogin';
import type { GoldenSlot } from '../../../tests/e2e/golden-paths/helpers/goldenSlot';
import { seedSlot, type SeedApi, type SeedReport } from './seedSlotData';

export function assertLocalBaseUrl(baseUrl: string): void {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { throw new Error('the seed url does not parse'); }
  if (host !== 'localhost' && host !== '127.0.0.1') throw new Error(`refusing to seed through ${host}: only a local dev server on isaflow_dev may be seeded`);
}

async function unwrap<T>(method: string, path: string, res: FetchResponse): Promise<T> {
  const body = await res.json().catch(async () => ({ nonJson: await res.text() }));
  if (res.status() < 200 || res.status() >= 300 || body?.success === false) {
    throw new Error(`${method} ${path} -> ${res.status()}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return (body?.data ?? body) as T;
}

export async function seedSlotViaApp(baseUrl: string, slot: GoldenSlot): Promise<SeedReport> {
  assertLocalBaseUrl(baseUrl);
  const ctx = new FetchContext(baseUrl);
  // loginGolden needs only get/post/storageState, which FetchContext has (see fetchContext.ts).
  await loginGolden(ctx as unknown as APIRequestContext, slot);
  const csrf = (await ctx.storageState()).cookies.find((c) => c.name === 'isaflow_csrf')?.value ?? '';
  const api: SeedApi = {
    get: async (path) => unwrap('GET', path, await ctx.get(path)),
    post: async (path, body) => unwrap('POST', path, await ctx.post(path, { data: body, headers: { 'x-csrf-token': csrf } })),
  };
  return seedSlot(api, randomUUID);
}
