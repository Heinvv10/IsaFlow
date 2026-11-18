/**
 * Seeds the Deploy Verification company THROUGH THE RUNNING APP as the verify user (so every gate, trigger, numbering rule and
 * posting path runs, as scripts/ci/golden-hosted/seed-demo-app.ts does for the hosted CI Demo, whose seeders this reuses), one
 * block at a time (seedBlocks.ts): a complete block is skipped, a missing or half-made one is made or finished. Smaller than the
 * CI Demo: no spec that runs in production measures volume.
 */
import type { ClientBase } from 'pg';
import { Client, seedMonths } from '../../ci/golden-hosted/seed-demo-app';
import { buildBlocks, type Block } from './seedBlocks';

export interface PlanLine { name: string; state: 'make' | 'skip' }

/** What a run would do, per block, without writing: for --dry-run. With no company yet (a dry run that would create it) every block is `make`. */
export async function planBlocks(
  db: ClientBase, ctx: { companyId: string; verifyUserId: string; now: Date } | null, blocks: Block[] = buildBlocks(),
): Promise<PlanLine[]> {
  const lines: PlanLine[] = [];
  for (const b of blocks) lines.push({ name: b.name, state: ctx && (await b.plan({ db, ...ctx })).complete ? 'skip' : 'make' });
  return lines;
}

export interface SeedOptions { baseUrl: string; email: string; password: string; companyId: string; verifyUserId: string; now?: Date }

/** The seam tests use: the logged-in client is built by `connect`. */
export type Connect = (baseUrl: string, email: string, password: string) => Promise<Client>;

const realConnect: Connect = async (baseUrl, email, password) => {
  const api = new Client(baseUrl);
  await api.login(email, password);
  return api;
};

/**
 * Logs in as the verify user, proves the app is on the company this run provisioned (an app backed by another database
 * would put the user elsewhere, or nowhere), then makes the blocks that are not complete.
 * @returns the names of the blocks it ran
 */
export async function seedVerifyCompany(
  db: ClientBase, opts: SeedOptions, blocks: Block[] = buildBlocks(), connect: Connect = realConnect,
): Promise<string[]> {
  const now = opts.now ?? new Date();
  const api = await connect(opts.baseUrl, opts.email, opts.password);
  const mine = await api.get<{ activeCompanyId?: string }>('/api/accounting/companies?action=user-companies');
  if (mine.activeCompanyId !== opts.companyId) {
    throw new Error(`the app at ${opts.baseUrl} puts the verify user in company ${mine.activeCompanyId ?? 'none'}, not ${opts.companyId}: it is not backed by the database that was provisioned; nothing was seeded`);
  }
  const ctx = { db, companyId: opts.companyId, verifyUserId: opts.verifyUserId, now };
  const months = seedMonths(now);
  const ran: string[] = [];
  for (const b of blocks) {
    const plan = await b.plan(ctx);
    if (plan.complete) continue;
    await plan.run({ ...ctx, api, months });
    ran.push(b.name);
  }
  return ran;
}
