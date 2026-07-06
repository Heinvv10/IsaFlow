/**
 * Phase 5 exit gate — a messy month closes via the Close Agent IN THE BROWSER.
 *
 * Seeds an isolated sandbox period with draft journals (the postable mess) via
 * the API, then drives the Close Agent UI on the Month-End tab to close it:
 * Start → Approve each proposed posting → dismiss advisories → Complete. Then
 * asserts (via the API) that every posted journal carries an audit-trail row
 * whose reasoning + source come from the close agent — the honesty guarantee.
 *
 * Run:
 *   BASE_URL=http://localhost:3200 E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… \
 *   bunx playwright test tests/e2e/close-agent --config playwright-standalone.config.ts
 */
import { test, expect } from '@playwright/test';
import { Api } from '../golden-paths/_api';

const CLOSE_AGENT = 'close-agent:v1';

/** Pick an OPEN period in a far-future year the golden suite never touches. */
async function pickSandboxPeriod(api: Api): Promise<{ id: string; month: string }> {
  for (const year of [2027, 2028, 2029]) {
    const periods = await api.get<Array<{ id: string; startDate: string; status: string }>>(
      `/api/accounting/fiscal-periods?year=${year}`,
    );
    const open = periods.find(p => p.status === 'open');
    if (open) return { id: open.id, month: String(open.startDate).slice(0, 7) };
  }
  throw new Error('No open sandbox period found in 2027–2029 for the Demo company');
}

async function borrowTwoAccounts(api: Api): Promise<[string, string]> {
  const posted = await api.get<{ entries: Array<{ id: string }> }>(
    '/api/accounting/journal-entries?status=posted&limit=1',
  );
  expect(posted.entries.length, 'Demo needs ≥1 posted journal to borrow accounts from').toBeGreaterThan(0);
  const detail = await api.get<{ lines: Array<{ glAccountId: string }> }>(
    `/api/accounting/journal-entries-detail?id=${posted.entries[0]!.id}`,
  );
  expect(detail.lines.length).toBeGreaterThanOrEqual(2);
  return [detail.lines[0]!.glAccountId, detail.lines[1]!.glAccountId];
}

test('messy Demo month closes via the Close Agent in the browser, with audit reasoning', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const api = await Api.login(baseURL!);
  const seededJeIds: string[] = [];
  const tag = `CAE-${Date.now().toString(36)}`;

  try {
    const period = await pickSandboxPeriod(api);
    const [acctA, acctB] = await borrowTwoAccounts(api);
    const entryDate = `${period.month}-15`;

    // ── Seed the mess: two BALANCED DRAFT journals in the sandbox period ──────
    for (let i = 1; i <= 2; i++) {
      const je = await api.post<{ id: string }>('/api/accounting/journal-entries', {
        entryDate,
        description: `${tag} accrual ${i}`,
        source: 'manual',
        fiscalPeriodId: period.id,
        lines: [
          { glAccountId: acctA, debit: 100 * i, credit: 0, description: `${tag} dr` },
          { glAccountId: acctB, debit: 0, credit: 100 * i, description: `${tag} cr` },
        ],
      });
      seededJeIds.push(je.id);
    }
    expect(seededJeIds.length).toBe(2);

    // ── Drive the Close Agent in the browser ─────────────────────────────────
    const context = await browser.newContext({ storageState: await api.ctx.storageState(), baseURL });
    const page = await context.newPage();
    try {
      await page.goto(`/accounting/month-end-workbench?period=${period.month}`);

      // The panel self-loads; the honesty banner is always present.
      await expect(page.getByText(/Nothing is posted until you approve it/i)).toBeVisible();

      await page.getByRole('button', { name: /Start close run/i }).click();

      // Proposed postings section appears with our two seeded drafts.
      await expect(page.getByText(/Proposed postings/i)).toBeVisible({ timeout: 20_000 });
      const approveButtons = page.getByRole('button', { name: /Approve & post/i });
      await expect(approveButtons.first()).toBeVisible();
      const approveCount = await approveButtons.count();
      expect(approveCount, 'both seeded drafts should be proposed for posting').toBeGreaterThanOrEqual(2);

      // Evidence is visible on demand (the honesty rule). Assert on the EXPANDED
      // content (the underlying-data link only renders inside the evidence block),
      // not the always-present toggle button.
      await page.getByRole('button', { name: /^Evidence$/i }).first().click();
      await expect(page.getByRole('link', { name: /Open the underlying data/i }).first()).toBeVisible();

      // Approve every proposed posting (always click the first remaining one).
      for (let i = 0; i < approveCount; i++) {
        await page.getByRole('button', { name: /Approve & post/i }).first().click();
        await expect(page.getByText('posted').first()).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(400); // allow the run to refresh between clicks
      }

      // Dismiss any advisory items so the run can complete.
      let dismiss = page.getByRole('button', { name: /^Dismiss$/i });
      while (await dismiss.count() > 0) {
        await dismiss.first().click();
        await page.waitForTimeout(400);
        dismiss = page.getByRole('button', { name: /^Dismiss$/i });
      }

      // Complete the close.
      const completeBtn = page.getByRole('button', { name: /Complete close/i });
      await expect(completeBtn).toBeEnabled({ timeout: 10_000 });
      await completeBtn.click();
      await expect(page.getByText(/Run status:\s*completed/i)).toBeVisible({ timeout: 15_000 });
    } finally {
      await context.close();
    }

    // ── Assert every seeded journal posted AND carries close-agent reasoning ──
    for (const id of seededJeIds) {
      const { items } = await api.get<{ items: Array<{ action: string; changes: { metadata?: Record<string, string> } | null }> }>(
        `/api/accounting/audit-log-entity?type=gl_journal_entry&id=${id}`,
      );
      const postRow = items.find(it => it.action === 'post' && it.changes?.metadata?.source === CLOSE_AGENT);
      expect(postRow, `JE ${id} must have a close-agent post audit row`).toBeTruthy();
      expect((postRow!.changes!.metadata!.reasoning ?? '').length,
        'audit row must carry non-empty reasoning').toBeGreaterThan(0);
    }
  } finally {
    // Best-effort cleanup: reverse the posted sandbox journals (nets to zero).
    await bestEffortCleanup(api, seededJeIds);
    await api.dispose();
  }
});

async function bestEffortCleanup(api: Api, jeIds: string[]): Promise<void> {
  for (const id of jeIds) {
    try {
      await api.post('/api/accounting/journal-entries-action', { id, action: 'reverse' });
    } catch {
      // Draft (never approved) or already reversed — nothing to undo.
    }
  }
}
