/**
 * Phase 2 — Mutating-action audit: accounting surface
 * Env: http://localhost:3200, ISAFlow Demo (00000000-0000-0000-0000-000000000001)
 * Covers: journal entry post/reverse.
 * Skipped (documented): dunning send (SMTP), sage commit (no sandbox creds).
 */
import { test, expect } from '@playwright/test';
import {
  BASE, DEMO_COMPANY_ID,
  initBrowser, closeBrowser, closeDbPool,
  apiPost,
  dbQuery, dbRun, recordResult, saveResults,
} from './mutating-actions-helpers';

test.beforeAll(async () => {
  await initBrowser();
});

test.afterAll(async () => {
  saveResults();
  await closeBrowser();
  await closeDbPool();
});

// ─── Journal entry: create → post → reverse ──────────────────────────────────

test('journal entry: create → post → reverse', async () => {
  const accounts = await dbQuery<{ id: string }>(
    `SELECT id FROM gl_accounts WHERE company_id = $1 AND is_active = true LIMIT 2`,
    [DEMO_COMPANY_ID],
  );

  if (accounts.length < 2) {
    recordResult({
      action: 'journal.post→reverse', pass: true, statusCode: 0, latencyMs: 0,
      dbDiff: { before: null, after: null, restored: null }, screenshotPath: '',
      notes: 'SKIP: fewer than 2 active GL accounts in dev — cannot create balanced entry',
    });
    return;
  }

  // Resolve demo company owner dynamically
  const [ownerRow] = await dbQuery<{ id: string }>(
    `SELECT u.id FROM company_users cu JOIN users u ON u.id = cu.user_id
      WHERE cu.company_id = $1 AND cu.role = 'owner' LIMIT 1`,
    [DEMO_COMPANY_ID],
  );
  if (!ownerRow) { test.skip(true, 'SKIP: no owner in demo company'); return; }
  const createdByUuid = ownerRow.id;

  const jeIds: string[] = [];
  try {
    // Seed a draft JE directly — no admin "create JE" endpoint exists
    const [je] = await dbQuery<{ id: string }>(
      `INSERT INTO gl_journal_entries
         (company_id, description, entry_date, status, created_by)
       VALUES ($1, 'Audit Phase 2 test JE', NOW()::date, 'draft', $2::uuid)
       RETURNING id`,
      [DEMO_COMPANY_ID, createdByUuid],
    );
    expect(je?.id, 'JE created in DB').toBeTruthy();

    await dbRun(
      `INSERT INTO gl_journal_lines
         (journal_entry_id, gl_account_id, debit, credit, description, company_id)
       VALUES
         ($1, $2, 100, 0, 'Debit — Phase 2 audit', $4),
         ($1, $3, 0, 100, 'Credit — Phase 2 audit', $4)`,
      [je.id, accounts[0].id, accounts[1].id, DEMO_COMPANY_ID],
    );

    const [before] = await dbQuery<{ status: string }>(
      `SELECT status FROM gl_journal_entries WHERE id = $1`, [je.id],
    );
    expect(before.status).toBe('draft');

    // Post via accounting API (requires X-Company-Id header, not X-Admin-Request)
    const t0 = Date.now();
    const { status: postStatus, body: postBody } = await apiPost(
      `/api/accounting/journal-entries-action`,
      { id: je.id, action: 'post' },
      { 'x-company-id': DEMO_COMPANY_ID, 'x-admin-request': '' },
    );
    const latency = Date.now() - t0;
    expect(postStatus, `JE post: ${JSON.stringify(postBody)}`).toBe(200);

    const [afterPost] = await dbQuery<{ status: string }>(
      `SELECT status FROM gl_journal_entries WHERE id = $1`, [je.id],
    );
    expect(afterPost.status).toBe('posted');

    // Reverse — creates a counter-entry; response body contains the reversal JE id.
    const { status: revStatus, body: revBody } = await apiPost(
      `/api/accounting/journal-entries-action`,
      { id: je.id, action: 'reverse' },
      { 'x-company-id': DEMO_COMPANY_ID, 'x-admin-request': '' },
    );
    expect(revStatus, `JE reverse: ${JSON.stringify(revBody)}`).toBe(200);

    // Extract reversal id from the API response (reverseJournalEntry returns the new entry).
    // Falls back to the reversal_of_id FK on gl_journal_entries as a second source of truth.
    const reversalIdFromResponse = (revBody as { data?: { id?: string } }).data?.id ?? '';
    const [reversalRow] = await dbQuery<{ id: string }>(
      `SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1 AND company_id = $2`,
      [je.id, DEMO_COMPANY_ID],
    );
    const reversalId = reversalIdFromResponse || reversalRow?.id ?? '';
    expect(reversalId, 'reversal JE id must be resolvable').toBeTruthy();

    jeIds.push(je.id, reversalId);

    // Collect the two JEs (original + reversal) by exact ids — no time-window heuristics.
    const allJes = await dbQuery<{ id: string; status: string }>(
      `SELECT id, status FROM gl_journal_entries WHERE id = ANY($1::uuid[]) AND company_id = $2`,
      [[je.id, reversalId], DEMO_COMPANY_ID],
    );
    expect(allJes.length).toBeGreaterThanOrEqual(2);
    // Original is now 'reversed'; reversal is 'posted'. Both are terminal states.
    expect(allJes.every((r) => r.status === 'posted' || r.status === 'reversed')).toBe(true);

    for (const { id } of allJes) {
      await dbRun(`DELETE FROM gl_journal_lines WHERE journal_entry_id = $1`, [id]);
      await dbRun(`DELETE FROM gl_journal_entries WHERE id = $1`, [id]);
    }

    const [finalCheck] = await dbQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM gl_journal_entries WHERE id = ANY($1::uuid[])`,
      [allJes.map((r) => r.id)],
    );
    expect(finalCheck.count).toBe('0');

    recordResult({
      action: 'journal.post→reverse', pass: true, statusCode: 200, latencyMs: latency,
      dbDiff: { before: 'draft', after: 'posted', restored: 'reversed+cleaned' },
      screenshotPath: '',
      notes: `JE seeded in DB, posted via API, reversed via API. ${allJes.length} JEs cleaned up.`,
    });
  } finally {
    for (const id of jeIds) {
      if (id) {
        await dbRun(`DELETE FROM gl_journal_lines WHERE journal_entry_id = $1`, [id]).catch(() => undefined);
        await dbRun(`DELETE FROM gl_journal_entries WHERE id = $1`, [id]).catch(() => undefined);
      }
    }
  }
});

// ─── Dunning send — SKIPPED ───────────────────────────────────────────────────

test.skip('dunning: send — SMTP not wired in dev', () => {
  // sendDunning() calls the mailer. In dev, MAILER_DRIVER is not set to 'stub'.
  // Without the stub driver, the call would throw a mailer config error (500)
  // or send a real email. Neither is acceptable for an automated audit.
  // Follow-up (P3): add MAILER_DRIVER=stub to test env and re-enable.
  // The dunning flow is already covered by prd06-phase5-dunning.spec.ts.
});

// ─── Sage commit — SKIPPED ────────────────────────────────────────────────────

test.skip('sage: commit — no Sage sandbox credentials in dev', () => {
  // sage-commit.ts calls the real Sage Business Cloud API.
  // Without a sandbox account + staging credentials (SAGE_CLIENT_ID etc.),
  // this would fail on auth or mutate a real Sage company.
  // Follow-up (P3): provision a Sage Developer sandbox and add env vars.
  // The Sage migration workflow is tested in the isaflow-sage-migration skill.
});
