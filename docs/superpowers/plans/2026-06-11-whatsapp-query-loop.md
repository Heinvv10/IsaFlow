# WhatsApp Client Query Loop (Dotbiz Workstream D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accountant flags a bank transaction → templated WhatsApp goes to the client (business owner) → the reply (text or slip photo) attaches back to that transaction via the existing capture pipeline → a resolution queue surfaces in the firm cockpit.

**Architecture:** A new `bank_tx_queries` table records each outbound query (mig 496). Outbound uses the existing `sendWhatsAppMessage` (freeform Twilio WABA). The existing inbound webhook (`ingestTwilioPayload`) gains a small hook: when the sender's number matches an open query for that company, media is ALSO inserted into the existing `bank_transaction_attachments` table (so slips appear in the existing Attachments modal on the bank-transactions page) and the query flips to `replied`. A `bankQuerySignal` (copying the `complianceSignal` pattern) surfaces replied queries on the `/bureau` cockpit and `/home` feed. A new `/accounting/bank/queries` page is the resolution queue.

**Tech Stack:** Next.js 14 pages router, TypeScript strict, Postgres via `sql` tagged template from `@/lib/neon`, Vitest with the `vi.mock('@/lib/neon')` sibling pattern, Twilio WABA via existing `whatsAppReplyService`.

**Worktree:** `/home/hein/Workspace/IsaFlow/.claude/worktrees/ws-d-whatsapp-query` on branch `feat/whatsapp-query-loop` (already created from `origin/master` @ bbe9abbd). ALL paths below are relative to this worktree. Run all commands from the worktree root. `bun install` first if node_modules is missing.

**Locked design decisions (do not relitigate):**
1. The "client" is the firm's client = the business owner of the company. Their WhatsApp number is stored per company in `companies.client_query_whatsapp` (default), overridable per query in the compose modal.
2. No Twilio send → no query row. `createAndSendQuery` fails closed with the send reason. (Demo/dev verification seeds rows directly in the DB, same as prior workstreams.)
3. Inbound matching is by normalized E.164 sender number against queries with `status IN ('sent','replied')` for the inbox's company, preferring `sent`, newest first. A second message (e.g. text then photo) appends to the same query.
4. We do NOT touch the hot `TX_SELECT` fragment in `bankTransactionQueryService.ts`. The compose modal fetches existing queries for the tx and warns instead.
5. Replies attach to `bank_transaction_attachments` (data-URL storage, 2MB cap — same as the manual upload API). Oversized media is still captured by the normal pipeline (`captured_documents`), just not attached; we log it.
6. Freeform WABA messages only (no template SIDs) — consistent with `whatsAppChaseService`. WABA template approval is Hein's external; the 24h-session constraint is accepted for the pilot.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `scripts/migrations/sql/496_bank_tx_queries.sql` | Create | Table + indexes + companies column |
| `src/modules/accounting/services/capture/bankTxQueryMessage.ts` | Create | Pure: compose message + normalize number |
| `src/modules/accounting/services/capture/bankTxQueryService.ts` | Create | create+send, list, resolve/cancel, settings |
| `src/modules/accounting/services/capture/bankTxQueryReplyService.ts` | Create | findOpenQuery, attachReplyMedia, markQueryReplied |
| `src/modules/accounting/services/capture/whatsAppInboundService.ts` | Modify | Hook reply routing into ingestTwilioPayload |
| `pages/api/accounting/bank-tx-queries/index.ts` | Create | GET list / POST create+send |
| `pages/api/accounting/bank-tx-queries/[id].ts` | Create | PATCH resolve/cancel |
| `pages/api/accounting/bank-tx-queries/settings.ts` | Create | GET/PATCH default client number |
| `src/modules/bureau/services/bankQuerySignal.ts` | Create | Cockpit signal (pure shaper + thin query) |
| `src/modules/bureau/services/bureauWorkAggregatorService.ts` | Modify | Register signal |
| `src/components/accounting/BankTxQueryModal.tsx` | Create | Compose/send modal |
| `src/components/accounting/BankTxTable.tsx` | Modify | `onAskClient` prop + button |
| `pages/accounting/bank-transactions/index.tsx` | Modify | Wire modal |
| `pages/accounting/bank/queries.tsx` | Create | Resolution queue page |
| `src/components/accounting/navSections/banking.ts` | Modify | Nav entry |
| Tests | Create | See per-task test files |
| `.claude.md` module docs + `AGENTS.md` mirrors | Modify/Create | capture services doc, new API group doc |

---

### Task 1: Migration 496

**Files:**
- Create: `scripts/migrations/sql/496_bank_tx_queries.sql`

- [ ] **Step 1: Confirm 496 is unused**

Run: `ls scripts/migrations/sql/ | grep -E '^49[5-9]'`
Expected: only `495_payroll_external_imports.sql`. If 496 exists (parallel session landed one), use 497 and substitute throughout.

- [ ] **Step 2: Write the migration**

```sql
-- 496: WhatsApp client query loop (Dotbiz Workstream D)
-- Accountant flags a bank transaction → templated WhatsApp to the client →
-- the reply (text or slip photo) attaches back to the transaction.

CREATE TABLE IF NOT EXISTS bank_tx_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  to_number TEXT NOT NULL,                -- bare E.164 (+27...), no whatsapp: prefix
  message_body TEXT NOT NULL,
  message_sid TEXT,                       -- Twilio MessageSid when available
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent','replied','resolved','cancelled')),
  reply_text TEXT,
  reply_capture_event_id UUID REFERENCES capture_events(id) ON DELETE SET NULL,
  created_by UUID,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replied_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_btq_company_status ON bank_tx_queries(company_id, status);
CREATE INDEX IF NOT EXISTS idx_btq_bank_tx ON bank_tx_queries(bank_transaction_id);
CREATE INDEX IF NOT EXISTS idx_btq_open_number
  ON bank_tx_queries(company_id, to_number)
  WHERE status IN ('sent','replied');

-- Default client WhatsApp number per company (the firm's client = business owner)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS client_query_whatsapp TEXT;
```

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/sql/496_bank_tx_queries.sql
git commit -m "feat(bank-queries): migration 496 — bank_tx_queries + companies.client_query_whatsapp"
```

---

### Task 2: Pure message helpers

**Files:**
- Create: `src/modules/accounting/services/capture/bankTxQueryMessage.ts`
- Test: `tests/unit/services/capture/bankTxQueryMessage.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import {
  composeBankTxQueryMessage,
  normalizeWhatsAppNumber,
} from '@/modules/accounting/services/capture/bankTxQueryMessage';

describe('composeBankTxQueryMessage', () => {
  const base = {
    companyName: 'Acme Trading',
    txDate: '2026-05-14',
    description: 'POS PURCHASE MAKRO SANDTON',
    amount: -1234.56,
  };

  it('includes company, date, description and absolute amount', () => {
    const { body } = composeBankTxQueryMessage(base);
    expect(body).toContain('Acme Trading');
    expect(body).toContain('14 May 2026');
    expect(body).toContain('POS PURCHASE MAKRO SANDTON');
    expect(body).toContain('R1 234,56'); // en-ZA group separator is NBSP-like; see step note
    expect(body).toContain('photo of the slip');
  });

  it('appends the reference when present', () => {
    const { body } = composeBankTxQueryMessage({ ...base, reference: 'INV-0042' });
    expect(body).toContain('(ref INV-0042)');
  });

  it('truncates long descriptions to 120 chars', () => {
    const { body } = composeBankTxQueryMessage({ ...base, description: 'X'.repeat(300) });
    expect(body).toContain('X'.repeat(120));
    expect(body).not.toContain('X'.repeat(121));
  });

  it('falls back when the description is blank', () => {
    const { body } = composeBankTxQueryMessage({ ...base, description: '   ' });
    expect(body).toContain('no description');
  });
});

describe('normalizeWhatsAppNumber', () => {
  it('passes through bare E.164', () => {
    expect(normalizeWhatsAppNumber('+27821234567')).toBe('+27821234567');
  });
  it('strips the whatsapp: prefix', () => {
    expect(normalizeWhatsAppNumber('whatsapp:+27821234567')).toBe('+27821234567');
  });
  it('strips spaces, dashes, dots and parens', () => {
    expect(normalizeWhatsAppNumber('+27 (82) 123-45.67')).toBe('+27821234567');
  });
  it('converts SA local 0-leading numbers to +27', () => {
    expect(normalizeWhatsAppNumber('0821234567')).toBe('+27821234567');
  });
  it('rejects garbage, short and unprefixed-international inputs', () => {
    expect(normalizeWhatsAppNumber('hello')).toBeNull();
    expect(normalizeWhatsAppNumber('+2782')).toBeNull();
    expect(normalizeWhatsAppNumber('27821234567')).toBeNull();
    expect(normalizeWhatsAppNumber('')).toBeNull();
  });
});
```

**Note on the `R1 234,56` assertion:** `toLocaleString('en-ZA')` may use U+00A0/U+202F as the group separator depending on ICU. Write the implementation to normalize the formatted amount with `.replace(/ | /g, ' ')` so the assertion against a plain space passes deterministically.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/unit/services/capture/bankTxQueryMessage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Bank-Tx Client Query — pure message helpers (Dotbiz Workstream D).
 * No DB, no clock: fully unit-testable.
 */

export interface BankTxQueryTemplateInput {
  companyName: string;
  txDate: string;        // YYYY-MM-DD
  description: string;
  amount: number;        // signed rand value as stored on bank_transactions
  reference?: string | null;
}

const MAX_DESC = 120;

/** Compose the freeform WhatsApp query message (≤ ~500 chars, text-only). */
export function composeBankTxQueryMessage(
  input: BankTxQueryTemplateInput,
): { body: string } {
  const { companyName, txDate, description, amount, reference } = input;
  const date = new Date(`${txDate}T00:00:00Z`).toLocaleDateString('en-ZA', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  const desc = description.trim().slice(0, MAX_DESC) || 'no description';
  const amt = Math.abs(amount)
    .toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .replace(/ | /g, ' ');
  const ref = reference?.trim() ? ` (ref ${reference.trim().slice(0, 40)})` : '';
  const body =
    `Hi, this is the accounting team for ${companyName}. ` +
    `Please help us identify this bank transaction: ` +
    `${date} — "${desc}" — R${amt}${ref}. ` +
    `Reply with a short note on what it was for, or send a photo of the slip or invoice.`;
  return { body };
}

/**
 * Normalise a WhatsApp destination to bare E.164 (+27821234567).
 * Accepts 'whatsapp:+27...', '+27 82 123-4567', '0821234567' (SA local).
 * Returns null when the input cannot be normalised safely.
 */
export function normalizeWhatsAppNumber(raw: string): string | null {
  const stripped = raw.replace(/^whatsapp:/i, '').replace(/[\s().\-]/g, '');
  if (/^\+\d{8,15}$/.test(stripped)) return stripped;
  if (/^0\d{9}$/.test(stripped)) return `+27${stripped.slice(1)}`;
  return null;
}
```

Note `14 May 2026`: en-ZA short month for May is `May`. If the date assertion fails on month formatting (e.g. `14 May 2026` vs `14 May 2026`), adjust the TEST to the actual en-ZA output — do not hand-roll a formatter.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/unit/services/capture/bankTxQueryMessage.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/capture/bankTxQueryMessage.ts tests/unit/services/capture/bankTxQueryMessage.test.ts
git commit -m "feat(bank-queries): pure compose + whatsapp number normalization"
```

---

### Task 3: bankTxQueryService (create+send, list, status, settings)

**Files:**
- Create: `src/modules/accounting/services/capture/bankTxQueryService.ts`
- Test: `tests/unit/services/capture/bankTxQueryService.test.ts`

Copy the neon mock pattern from `tests/unit/services/payroll/payrollExternalImportService.test.ts` (routeMock helper). ALSO mock the send:

```ts
const sendMock = vi.fn(async (_to: string, _body: string) => ({ sent: true as boolean, reason: undefined as string | undefined }));
vi.mock('@/modules/accounting/services/capture/whatsAppReplyService', () => ({
  sendWhatsAppMessage: (to: string, body: string) => sendMock(to, body),
}));
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

const sendMock = vi.fn(async (_to: string, _body: string): Promise<{ sent: boolean; reason?: string }> => ({ sent: true }));
vi.mock('@/modules/accounting/services/capture/whatsAppReplyService', () => ({
  sendWhatsAppMessage: (to: string, body: string) => sendMock(to, body),
}));

import {
  createAndSendQuery,
  listQueries,
  setQueryStatus,
  getQuerySettings,
  saveQuerySettings,
} from '@/modules/accounting/services/capture/bankTxQueryService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TX_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const QUERY_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const TX_ROW = {
  id: TX_ID, transaction_date: new Date('2026-05-14T00:00:00Z'),
  description: 'POS PURCHASE MAKRO', amount: '-1234.56', reference: null,
  company_name: 'Acme Trading',
};

function routeMock(routes: Array<{ match: string; rows: unknown[] }>) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    const hit = routes.find((r) => q.includes(r.match));
    return Promise.resolve(hit ? hit.rows : []);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
  sendMock.mockClear();
  sendMock.mockResolvedValue({ sent: true });
});

describe('createAndSendQuery', () => {
  const input = { bankTransactionId: TX_ID, toNumber: '082 123 4567', message: null, saveAsDefault: false, userId: null };

  it('rejects an unnormalizable number without touching the DB', async () => {
    const res = await createAndSendQuery(COMPANY_ID, { ...input, toNumber: 'nonsense' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/number/i);
    expect(sqlCalls.length).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('fails when the bank tx does not belong to the company', async () => {
    routeMock([{ match: 'FROM bank_transactions', rows: [] }]);
    const res = await createAndSendQuery(COMPANY_ID, input);
    expect(res.ok).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does NOT insert a row when the Twilio send fails', async () => {
    routeMock([{ match: 'FROM bank_transactions', rows: [TX_ROW] }]);
    sendMock.mockResolvedValue({ sent: false, reason: 'twilio env vars not configured' });
    const res = await createAndSendQuery(COMPANY_ID, input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/twilio/i);
    expect(sqlCalls.some((c) => c.sql.includes('INSERT INTO bank_tx_queries'))).toBe(false);
  });

  it('sends a composed message to the normalized number and inserts the row', async () => {
    routeMock([
      { match: 'FROM bank_transactions', rows: [TX_ROW] },
      { match: 'INSERT INTO bank_tx_queries', rows: [{ id: QUERY_ID, status: 'sent' }] },
    ]);
    const res = await createAndSendQuery(COMPANY_ID, input);
    expect(res.ok).toBe(true);
    expect(sendMock).toHaveBeenCalledWith('whatsapp:+27821234567', expect.stringContaining('Acme Trading'));
    const insert = sqlCalls.find((c) => c.sql.includes('INSERT INTO bank_tx_queries'));
    expect(insert).toBeDefined();
    expect(insert!.values).toContain(COMPANY_ID);
    expect(insert!.values).toContain('+27821234567');
  });

  it('uses a caller-supplied message verbatim', async () => {
    routeMock([
      { match: 'FROM bank_transactions', rows: [TX_ROW] },
      { match: 'INSERT INTO bank_tx_queries', rows: [{ id: QUERY_ID, status: 'sent' }] },
    ]);
    await createAndSendQuery(COMPANY_ID, { ...input, message: 'What was this payment for?' });
    expect(sendMock).toHaveBeenCalledWith('whatsapp:+27821234567', 'What was this payment for?');
  });

  it('persists the default number when saveAsDefault is set', async () => {
    routeMock([
      { match: 'FROM bank_transactions', rows: [TX_ROW] },
      { match: 'INSERT INTO bank_tx_queries', rows: [{ id: QUERY_ID, status: 'sent' }] },
      { match: 'UPDATE companies', rows: [] },
    ]);
    await createAndSendQuery(COMPANY_ID, { ...input, saveAsDefault: true });
    const upd = sqlCalls.find((c) => c.sql.includes('UPDATE companies'));
    expect(upd).toBeDefined();
    expect(upd!.values).toContain('+27821234567');
  });
});

describe('listQueries', () => {
  it('scopes by company and joins tx context', async () => {
    routeMock([{ match: 'FROM bank_tx_queries', rows: [] }]);
    await listQueries(COMPANY_ID, { status: 'replied' });
    const q = sqlCalls[0]!;
    expect(q.sql).toContain('q.company_id');
    expect(q.sql).toContain('JOIN bank_transactions');
    expect(q.values).toContain(COMPANY_ID);
    expect(q.values).toContain('replied');
  });
});

describe('setQueryStatus', () => {
  it('resolves from sent or replied', async () => {
    routeMock([{ match: 'UPDATE bank_tx_queries', rows: [{ id: QUERY_ID }] }]);
    const res = await setQueryStatus(COMPANY_ID, QUERY_ID, 'resolve');
    expect(res.ok).toBe(true);
    const upd = sqlCalls.find((c) => c.sql.includes('UPDATE bank_tx_queries'))!;
    expect(upd.sql).toContain("'sent'");
    expect(upd.sql).toContain("'replied'");
  });

  it('cancel only allowed from sent; reports invalid state', async () => {
    routeMock([{ match: 'UPDATE bank_tx_queries', rows: [] }]);
    const res = await setQueryStatus(COMPANY_ID, QUERY_ID, 'cancel');
    expect(res.ok).toBe(false);
  });
});

describe('query settings', () => {
  it('reads the company default + name', async () => {
    routeMock([{ match: 'FROM companies', rows: [{ client_query_whatsapp: '+27821234567', name: 'Acme Trading' }] }]);
    const s = await getQuerySettings(COMPANY_ID);
    expect(s).toEqual({ clientQueryWhatsapp: '+27821234567', companyName: 'Acme Trading' });
  });

  it('saves a normalized default and rejects junk', async () => {
    routeMock([{ match: 'UPDATE companies', rows: [] }]);
    expect((await saveQuerySettings(COMPANY_ID, '082 123 4567')).ok).toBe(true);
    expect((await saveQuerySettings(COMPANY_ID, 'junk')).ok).toBe(false);
    expect((await saveQuerySettings(COMPANY_ID, null)).ok).toBe(true); // clearing is allowed
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/unit/services/capture/bankTxQueryService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Bank-Tx Client Query Service — Dotbiz Workstream D.
 * Creates/sends WhatsApp queries about bank transactions, lists them,
 * and manages the sent → replied → resolved | cancelled lifecycle.
 * Reply-side handling lives in bankTxQueryReplyService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import { sendWhatsAppMessage } from './whatsAppReplyService';
import {
  composeBankTxQueryMessage,
  normalizeWhatsAppNumber,
} from './bankTxQueryMessage';

type Row = DbRow;

export interface CreateQueryInput {
  bankTransactionId: string;
  toNumber: string;
  message?: string | null;
  saveAsDefault?: boolean;
  userId: string | null;
}

export type CreateQueryResult =
  | { ok: true; query: Row }
  | { ok: false; reason: string };

function toDateString(v: Date | string): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

export async function createAndSendQuery(
  companyId: string,
  input: CreateQueryInput,
): Promise<CreateQueryResult> {
  const toNumber = normalizeWhatsAppNumber(input.toNumber);
  if (!toNumber) return { ok: false, reason: 'invalid whatsapp number' };

  const [tx] = (await sql`
    SELECT bt.id, bt.transaction_date, bt.description, bt.amount, bt.reference,
           c.name AS company_name
    FROM bank_transactions bt
    JOIN companies c ON c.id = bt.company_id
    WHERE bt.id = ${input.bankTransactionId}::uuid
      AND bt.company_id = ${companyId}::uuid
    LIMIT 1
  `) as Row[];
  if (!tx) return { ok: false, reason: 'bank transaction not found' };

  const body =
    input.message?.trim() ||
    composeBankTxQueryMessage({
      companyName: String(tx.company_name ?? 'your accountant'),
      txDate: toDateString(tx.transaction_date as Date | string),
      description: String(tx.description ?? ''),
      amount: Number(tx.amount ?? 0),
      reference: tx.reference == null ? null : String(tx.reference),
    }).body;

  const sendResult = await sendWhatsAppMessage(`whatsapp:${toNumber}`, body);
  if (!sendResult.sent) {
    log.warn('bankTxQuery: send failed', {
      companyId, bankTransactionId: input.bankTransactionId, reason: sendResult.reason,
    }, 'bank-tx-queries');
    return { ok: false, reason: sendResult.reason ?? 'send failed' };
  }

  const [query] = (await sql`
    INSERT INTO bank_tx_queries (
      company_id, bank_transaction_id, to_number, message_body, created_by
    ) VALUES (
      ${companyId}::uuid, ${input.bankTransactionId}::uuid,
      ${toNumber}, ${body}, ${input.userId}
    )
    RETURNING *
  `) as Row[];

  if (input.saveAsDefault) {
    await sql`
      UPDATE companies SET client_query_whatsapp = ${toNumber}
      WHERE id = ${companyId}::uuid
    `;
  }

  log.info('bankTxQuery: sent', {
    companyId, bankTransactionId: input.bankTransactionId, queryId: query?.id, to: toNumber,
  }, 'bank-tx-queries');

  return { ok: true, query: query! };
}

export interface ListQueryFilters {
  status?: 'sent' | 'replied' | 'resolved' | 'cancelled';
  bankTransactionId?: string;
}

export async function listQueries(
  companyId: string,
  filters?: ListQueryFilters,
): Promise<Row[]> {
  const status = filters?.status ?? null;
  const txId = filters?.bankTransactionId ?? null;
  return (await sql`
    SELECT q.id, q.bank_transaction_id, q.to_number, q.message_body, q.status,
           q.reply_text, q.sent_at, q.replied_at, q.resolved_at,
           bt.transaction_date, bt.description AS tx_description,
           bt.amount, bt.status AS tx_status,
           ga.account_name AS bank_account_name,
           (SELECT COUNT(*)::int FROM bank_transaction_attachments bta
             WHERE bta.bank_transaction_id = q.bank_transaction_id) AS attachment_count
    FROM bank_tx_queries q
    JOIN bank_transactions bt ON bt.id = q.bank_transaction_id
    LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
    WHERE q.company_id = ${companyId}::uuid
      AND (${status}::text IS NULL OR q.status = ${status})
      AND (${txId}::uuid IS NULL OR q.bank_transaction_id = ${txId}::uuid)
    ORDER BY q.sent_at DESC
    LIMIT 200
  `) as Row[];
}

export async function setQueryStatus(
  companyId: string,
  queryId: string,
  action: 'resolve' | 'cancel',
): Promise<{ ok: boolean; reason?: string }> {
  const rows =
    action === 'resolve'
      ? ((await sql`
          UPDATE bank_tx_queries
          SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
          WHERE id = ${queryId}::uuid AND company_id = ${companyId}::uuid
            AND status IN ('sent','replied')
          RETURNING id
        `) as Row[])
      : ((await sql`
          UPDATE bank_tx_queries
          SET status = 'cancelled', updated_at = NOW()
          WHERE id = ${queryId}::uuid AND company_id = ${companyId}::uuid
            AND status = 'sent'
          RETURNING id
        `) as Row[]);
  if (rows.length === 0) return { ok: false, reason: 'query not found or invalid state' };
  log.info('bankTxQuery: status changed', { companyId, queryId, action }, 'bank-tx-queries');
  return { ok: true };
}

export async function getQuerySettings(
  companyId: string,
): Promise<{ clientQueryWhatsapp: string | null; companyName: string }> {
  const [row] = (await sql`
    SELECT client_query_whatsapp, name FROM companies
    WHERE id = ${companyId}::uuid LIMIT 1
  `) as Row[];
  return {
    clientQueryWhatsapp: row?.client_query_whatsapp ? String(row.client_query_whatsapp) : null,
    companyName: row?.name ? String(row.name) : '',
  };
}

export async function saveQuerySettings(
  companyId: string,
  clientQueryWhatsapp: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  let normalized: string | null = null;
  if (clientQueryWhatsapp != null && clientQueryWhatsapp.trim() !== '') {
    normalized = normalizeWhatsAppNumber(clientQueryWhatsapp);
    if (!normalized) return { ok: false, reason: 'invalid whatsapp number' };
  }
  await sql`
    UPDATE companies SET client_query_whatsapp = ${normalized}
    WHERE id = ${companyId}::uuid
  `;
  return { ok: true };
}
```

**IMPORTANT — check `(${status}::text IS NULL OR ...)` pattern:** grep the repo for an existing optional-filter idiom (`rg "IS NULL OR" src/modules/accounting/services | head`). If the codebase instead branches into separate `sql` calls per filter combination (like `bankTransactionQueryService.getBankTransactions` does), follow THAT pattern — build 4 explicit branches (no filter / status / txId / both). Match the house style; do not invent a new one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/unit/services/capture/bankTxQueryService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/capture/bankTxQueryService.ts tests/unit/services/capture/bankTxQueryService.test.ts
git commit -m "feat(bank-queries): create/send/list/status service"
```

---

### Task 4: bankTxQueryReplyService (inbound matching + attach)

**Files:**
- Create: `src/modules/accounting/services/capture/bankTxQueryReplyService.ts`
- Test: `tests/unit/services/capture/bankTxQueryReplyService.test.ts`

- [ ] **Step 1: Write the failing tests**

Same neon mock pattern as Task 3 (no whatsAppReplyService mock needed here).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

import {
  findOpenQuery,
  attachReplyMedia,
  markQueryReplied,
} from '@/modules/accounting/services/capture/bankTxQueryReplyService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const QUERY_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TX_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function routeMock(routes: Array<{ match: string; rows: unknown[] }>) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    const hit = routes.find((r) => q.includes(r.match));
    return Promise.resolve(hit ? hit.rows : []);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('findOpenQuery', () => {
  it('matches by company + normalized number, preferring sent, newest first', async () => {
    routeMock([{ match: 'FROM bank_tx_queries', rows: [{ id: QUERY_ID, bank_transaction_id: TX_ID, status: 'sent' }] }]);
    const q = await findOpenQuery(COMPANY_ID, '+27821234567');
    expect(q).toEqual({ id: QUERY_ID, bankTransactionId: TX_ID, status: 'sent' });
    const call = sqlCalls[0]!;
    expect(call.values).toContain(COMPANY_ID);
    expect(call.values).toContain('+27821234567');
    expect(call.sql).toMatch(/status IN \('sent',\s*'replied'\)/);
    expect(call.sql).toContain('ORDER BY');
  });

  it('returns null when nothing is open or the number is junk', async () => {
    expect(await findOpenQuery(COMPANY_ID, '+27000000000')).toBeNull();
    expect(await findOpenQuery(COMPANY_ID, 'garbage')).toBeNull();
  });
});

describe('attachReplyMedia', () => {
  const query = { id: QUERY_ID, bankTransactionId: TX_ID, status: 'sent' as const };

  it('inserts a data-URL attachment for the queried bank tx', async () => {
    routeMock([{ match: 'INSERT INTO bank_transaction_attachments', rows: [{ id: 'x' }] }]);
    const ok = await attachReplyMedia(COMPANY_ID, query, {
      buffer: Buffer.from('fakeimg'),
      mimeType: 'image/jpeg',
      fileName: 'whatsapp_SM123_0.jpeg',
    });
    expect(ok).toBe(true);
    const ins = sqlCalls.find((c) => c.sql.includes('INSERT INTO bank_transaction_attachments'))!;
    expect(ins.values).toContain(TX_ID);
    const dataUrl = ins.values.find((v) => typeof v === 'string' && v.startsWith('data:image/jpeg;base64,'));
    expect(dataUrl).toBeDefined();
  });

  it('skips media over 2MB without inserting', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1);
    const ok = await attachReplyMedia(COMPANY_ID, query, {
      buffer: big, mimeType: 'image/jpeg', fileName: 'big.jpeg',
    });
    expect(ok).toBe(false);
    expect(sqlCalls.some((c) => c.sql.includes('INSERT INTO bank_transaction_attachments'))).toBe(false);
  });
});

describe('markQueryReplied', () => {
  it('flips to replied, appends text, keeps the first capture event', async () => {
    routeMock([{ match: 'UPDATE bank_tx_queries', rows: [{ id: QUERY_ID }] }]);
    await markQueryReplied(COMPANY_ID, QUERY_ID, 'it was the printer repair', 'dddddddd-dddd-dddd-dddd-dddddddddddd');
    const upd = sqlCalls.find((c) => c.sql.includes('UPDATE bank_tx_queries'))!;
    expect(upd.sql).toContain("status = 'replied'");
    expect(upd.sql).toContain('COALESCE');
    expect(upd.values).toContain(COMPANY_ID);
    expect(upd.values).toContain('it was the printer repair');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/unit/services/capture/bankTxQueryReplyService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * Bank-Tx Client Query — inbound reply side (Dotbiz Workstream D).
 * Called from whatsAppInboundService when a WhatsApp message arrives from a
 * number with an open query: media attaches to the queried bank transaction
 * (bank_transaction_attachments, same surface as manual uploads) and the
 * query flips to 'replied'.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import { normalizeWhatsAppNumber } from './bankTxQueryMessage';

type Row = DbRow;

/** Same cap as the manual upload API (bank-tx-attachments.ts). */
const MAX_ATTACH_BYTES = 2 * 1024 * 1024;

export interface OpenQuery {
  id: string;
  bankTransactionId: string;
  status: 'sent' | 'replied';
}

export async function findOpenQuery(
  companyId: string,
  fromNumber: string,
): Promise<OpenQuery | null> {
  const normalized = normalizeWhatsAppNumber(fromNumber);
  if (!normalized) return null;
  const [row] = (await sql`
    SELECT id, bank_transaction_id, status
    FROM bank_tx_queries
    WHERE company_id = ${companyId}::uuid
      AND to_number = ${normalized}
      AND status IN ('sent', 'replied')
    ORDER BY (status = 'sent') DESC, sent_at DESC
    LIMIT 1
  `) as Row[];
  if (!row) return null;
  return {
    id: String(row.id),
    bankTransactionId: String(row.bank_transaction_id),
    status: row.status as 'sent' | 'replied',
  };
}

export interface ReplyMedia {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export async function attachReplyMedia(
  companyId: string,
  query: OpenQuery,
  media: ReplyMedia,
): Promise<boolean> {
  if (media.buffer.length > MAX_ATTACH_BYTES) {
    log.warn('bankTxQueryReply: media over attachment cap — captured but not attached', {
      companyId, queryId: query.id, size: media.buffer.length, fileName: media.fileName,
    }, 'bank-tx-queries');
    return false;
  }
  const dataUrl = `data:${media.mimeType};base64,${media.buffer.toString('base64')}`;
  await sql`
    INSERT INTO bank_transaction_attachments
      (bank_transaction_id, file_url, file_name, file_size, uploaded_by)
    VALUES
      (${query.bankTransactionId}::uuid, ${dataUrl}, ${media.fileName},
       ${media.buffer.length}, NULL)
  `;
  log.info('bankTxQueryReply: media attached to bank tx', {
    companyId, queryId: query.id, bankTransactionId: query.bankTransactionId,
    fileName: media.fileName, size: media.buffer.length,
  }, 'bank-tx-queries');
  return true;
}

export async function markQueryReplied(
  companyId: string,
  queryId: string,
  replyText: string | null,
  captureEventId: string | null,
): Promise<void> {
  await sql`
    UPDATE bank_tx_queries
    SET status = 'replied',
        replied_at = COALESCE(replied_at, NOW()),
        reply_text = CASE
          WHEN ${replyText}::text IS NULL OR ${replyText} = '' THEN reply_text
          WHEN reply_text IS NULL THEN ${replyText}
          ELSE reply_text || E'\n' || ${replyText}
        END,
        reply_capture_event_id = COALESCE(reply_capture_event_id, ${captureEventId}::uuid),
        updated_at = NOW()
    WHERE id = ${queryId}::uuid
      AND company_id = ${companyId}::uuid
  `;
  log.info('bankTxQueryReply: query marked replied', {
    companyId, queryId, hasText: Boolean(replyText), captureEventId,
  }, 'bank-tx-queries');
}
```

Note: `attachReplyMedia` does not re-verify tx ownership — `query` comes from `findOpenQuery`, which is company-scoped. State that in a comment if the reviewer asks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/unit/services/capture/bankTxQueryReplyService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/capture/bankTxQueryReplyService.ts tests/unit/services/capture/bankTxQueryReplyService.test.ts
git commit -m "feat(bank-queries): inbound reply matching + attach service"
```

---

### Task 5: Hook reply routing into the inbound webhook

**Files:**
- Modify: `src/modules/accounting/services/capture/whatsAppInboundService.ts`
- Test: `tests/unit/services/capture/whatsAppInboundService.test.ts` (extend if it exists; create with ONLY the new cases if it does not — do not retro-test the whole existing service)

- [ ] **Step 1: Write the failing tests**

Mock `@/lib/neon` (route by SQL match: `capture_inboxes` → one inbox row; `INSERT INTO captured_documents` → `[{id}]`; `INSERT INTO capture_events` → `[{id}]`), mock `@/lib/documentStorage` (`sha256: () => 'hash'`, `storeCapturedBytes: async () => ({ bucket: 'b', path: 'p' })`), mock `./captureRouterService` (`routeEvent: async () => undefined`), mock global `fetch` for Twilio media (return ok with a small JPEG buffer; set `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` env in the test via `vi.stubEnv`), and mock `./bankTxQueryReplyService`:

```ts
const findOpenQueryMock = vi.fn(async () => null as null | { id: string; bankTransactionId: string; status: 'sent' });
const attachReplyMediaMock = vi.fn(async () => true);
const markQueryRepliedMock = vi.fn(async () => undefined);
vi.mock('@/modules/accounting/services/capture/bankTxQueryReplyService', () => ({
  findOpenQuery: (...a: unknown[]) => findOpenQueryMock(...(a as [])),
  attachReplyMedia: (...a: unknown[]) => attachReplyMediaMock(...(a as [])),
  markQueryReplied: (...a: unknown[]) => markQueryRepliedMock(...(a as [])),
}));
```

Test cases:

```ts
const OPEN_QUERY = { id: 'q1', bankTransactionId: 'tx1', status: 'sent' as const };

it('attaches reply media and marks the query replied', async () => {
  findOpenQueryMock.mockResolvedValue(OPEN_QUERY);
  const res = await ingestTwilioPayload({
    From: 'whatsapp:+27821234567', To: 'whatsapp:+14155238886',
    Body: 'here is the slip', NumMedia: '1', MessageSid: 'SM1',
    MediaUrl0: 'https://api.twilio.com/m/0', MediaContentType0: 'image/jpeg',
  });
  expect('rejected' in res).toBe(false);
  expect(attachReplyMediaMock).toHaveBeenCalledTimes(1);
  expect(markQueryRepliedMock).toHaveBeenCalledWith(
    expect.any(String), 'q1', 'here is the slip', expect.any(String),
  );
});

it('marks a text-only non-command reply as replied (no capture event required)', async () => {
  findOpenQueryMock.mockResolvedValue(OPEN_QUERY);
  await ingestTwilioPayload({
    From: 'whatsapp:+27821234567', To: 'whatsapp:+14155238886',
    Body: 'that was the printer repair', NumMedia: '0', MessageSid: 'SM2',
  });
  expect(attachReplyMediaMock).not.toHaveBeenCalled();
  expect(markQueryRepliedMock).toHaveBeenCalledWith(
    expect.any(String), 'q1', 'that was the printer repair', null,
  );
});

it('does nothing query-related when no open query matches', async () => {
  findOpenQueryMock.mockResolvedValue(null);
  await ingestTwilioPayload({
    From: 'whatsapp:+27829999999', To: 'whatsapp:+14155238886',
    Body: 'hello', NumMedia: '0', MessageSid: 'SM3',
  });
  expect(attachReplyMediaMock).not.toHaveBeenCalled();
  expect(markQueryRepliedMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/unit/services/capture/whatsAppInboundService.test.ts`
Expected: FAIL — the new assertions fail (mocked fns never called).

- [ ] **Step 3: Implement the hook**

In `whatsAppInboundService.ts`:

1. Add import:
```ts
import { findOpenQuery, attachReplyMedia, markQueryReplied } from './bankTxQueryReplyService';
```
2. After the inbox is resolved (right after `const inboxId = String(inbox.id);`, ~line 141):
```ts
  // Workstream D: is this sender replying to an open bank-tx query?
  const openQuery = await findOpenQuery(companyId, stripWaPrefix(payload.From));
```
3. Inside the media loop, immediately after the `log.info('whatsAppInbound: capture event created', ...)` call (the buffer is still in scope):
```ts
    if (openQuery) {
      await attachReplyMedia(companyId, openQuery, {
        buffer, mimeType, fileName,
      });
    }
```
4. After the text-command block (just before the final `return`):
```ts
  // Workstream D: flip the query to replied (text and/or media)
  const replyBody = (payload.Body ?? '').trim();
  if (openQuery && (eventIds.length > 0 || replyBody)) {
    await markQueryReplied(companyId, openQuery.id, replyBody || null, eventIds[0] ?? null);
  }
```

The file is 279 lines; these additions keep it under the 300-line cap (~296). If it lands over 300, move the `fetchTwilioMedia` helper into a new `twilioMediaFetch.ts` file in the same directory (export it, import it back) — do NOT trim logging to fit.

- [ ] **Step 4: Run the new tests + the full capture suite**

Run: `bunx vitest run tests/unit/services/capture/`
Expected: ALL PASS (no regressions in inboundEmailService/captureRouterService etc.).

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/capture/whatsAppInboundService.ts tests/unit/services/capture/whatsAppInboundService.test.ts
git commit -m "feat(bank-queries): route inbound WhatsApp replies to open queries"
```

---

### Task 6: API routes

**Files:**
- Create: `pages/api/accounting/bank-tx-queries/index.ts`
- Create: `pages/api/accounting/bank-tx-queries/[id].ts`
- Create: `pages/api/accounting/bank-tx-queries/settings.ts`

Routes are thin delegations to the Task-3 service — repo norm is no unit tests for thin routes (services carry the tests); they're exercised by type-check + browser verification.

- [ ] **Step 1: index.ts**

```ts
/**
 * Bank-Tx Client Queries API (Dotbiz Workstream D)
 *
 * GET  /api/accounting/bank-tx-queries?status=&bankTransactionId=
 *   → List queries for the company, newest first (joined with tx context).
 *
 * POST /api/accounting/bank-tx-queries
 *   Body: { bankTransactionId, toNumber, message?, saveAsDefault? }
 *   → Compose (or use supplied message), send via WhatsApp, record the query.
 *     No Twilio send → no row (fails closed with the reason).
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import {
  createAndSendQuery,
  listQueries,
} from '@/modules/accounting/services/capture/bankTxQueryService';

const StatusSchema = z.enum(['sent', 'replied', 'resolved', 'cancelled']);

const PostSchema = z.object({
  bankTransactionId: UUID,
  toNumber: z.string().min(8).max(30),
  message: z.string().max(1000).optional(),
  saveAsDefault: z.boolean().optional(),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    const status = statusRaw ? StatusSchema.safeParse(statusRaw) : null;
    if (status && !status.success) return apiResponse.badRequest(res, 'invalid status');
    const txIdRaw = typeof req.query.bankTransactionId === 'string' ? req.query.bankTransactionId : undefined;
    const txId = txIdRaw ? UUID.safeParse(txIdRaw) : null;
    if (txId && !txId.success) return apiResponse.badRequest(res, 'invalid bankTransactionId');

    const rows = await listQueries(companyId, {
      status: status?.success ? status.data : undefined,
      bankTransactionId: txId?.success ? txId.data : undefined,
    });
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const parsed = PostSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const result = await createAndSendQuery(companyId, {
      bankTransactionId: parsed.data.bankTransactionId,
      toNumber: parsed.data.toNumber,
      message: parsed.data.message ?? null,
      saveAsDefault: parsed.data.saveAsDefault ?? false,
      userId: req.user?.id ?? null,
    });
    if (!result.ok) return apiResponse.badRequest(res, result.reason);
    return apiResponse.created(res, result.query, 'Query sent');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
```

If `withWriteAccess(handler)` needs the cast idiom, copy it from `bank-tx-attachments.ts`: `withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])`. Check `@/lib/schemas/common` actually exports `UUID` (bank-tx-attachments.ts imports it — it does).

- [ ] **Step 2: [id].ts**

```ts
/**
 * PATCH /api/accounting/bank-tx-queries/[id]
 *   Body: { action: 'resolve' | 'cancel' }
 *   resolve: allowed from sent|replied. cancel: allowed from sent only.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { setQueryStatus } from '@/modules/accounting/services/capture/bankTxQueryService';

const BodySchema = z.object({ action: z.enum(['resolve', 'cancel']) }).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  if (req.method !== 'PATCH') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH']);
  }
  const id = UUID.safeParse(req.query.id);
  if (!id.success) return apiResponse.badRequest(res, 'invalid id');
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const result = await setQueryStatus(companyId, id.data, parsed.data.action);
  if (!result.ok) return apiResponse.notFound(res, 'Bank-tx query', id.data);
  return apiResponse.success(res, { id: id.data, action: parsed.data.action });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
```

- [ ] **Step 3: settings.ts**

```ts
/**
 * GET  /api/accounting/bank-tx-queries/settings → { clientQueryWhatsapp, companyName }
 * PATCH /api/accounting/bank-tx-queries/settings { clientQueryWhatsapp: string | null }
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getQuerySettings,
  saveQuerySettings,
} from '@/modules/accounting/services/capture/bankTxQueryService';

const BodySchema = z.object({ clientQueryWhatsapp: z.string().max(30).nullable() }).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  if (req.method === 'GET') {
    return apiResponse.success(res, await getQuerySettings(companyId));
  }
  if (req.method === 'PATCH') {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const result = await saveQuerySettings(companyId, parsed.data.clientQueryWhatsapp);
    if (!result.ok) return apiResponse.badRequest(res, result.reason ?? 'invalid');
    return apiResponse.success(res, await getQuerySettings(companyId));
  }
  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
```

- [ ] **Step 4: Type-check**

Run: `bun run type-check`
Expected: clean. (Fix import drift — e.g. the exact `withErrorHandler` path — by copying from `bank-tx-attachments.ts`, which is the closest sibling.)

- [ ] **Step 5: Commit**

```bash
git add pages/api/accounting/bank-tx-queries/
git commit -m "feat(bank-queries): API routes — list/create, resolve/cancel, settings"
```

---

### Task 7: Cockpit signal

**Files:**
- Create: `src/modules/bureau/services/bankQuerySignal.ts`
- Modify: `src/modules/bureau/services/bureauWorkAggregatorService.ts` (register, ~line 231)
- Test: `tests/unit/services/bureau/bankQuerySignal.test.ts` (check where existing bureau signal tests live first — `rg -l "complianceSignal|shapeCompliance" tests/` — and put the test next to those)

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { shapeBankQueries, type BankQueryCountRow } from '@/modules/bureau/services/bankQuerySignal';
import type { CompanyMeta } from '@/modules/bureau/services/bureauWorkTypes';

const TODAY = new Date('2026-06-11T08:00:00Z');
const META = new Map<string, CompanyMeta>([
  ['c1', { bureau_id: 'b1', bureau_name: 'Dotbiz', company_name: 'Acme Trading' } as CompanyMeta],
]);

describe('shapeBankQueries', () => {
  it('emits a due_soon item when replies await review', () => {
    const rows: BankQueryCountRow[] = [{ company_id: 'c1', replied: 2, awaiting: 1, oldest_sent: '2026-06-10T00:00:00Z' }];
    const items = shapeBankQueries(rows, META, TODAY);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      companyId: 'c1', severity: 'due_soon', href: '/accounting/bank/queries',
    });
    expect(items[0]!.detail).toContain('2');
  });

  it('emits an info item when only stale (≥3 days) unanswered queries exist', () => {
    const rows: BankQueryCountRow[] = [{ company_id: 'c1', replied: 0, awaiting: 3, oldest_sent: '2026-06-01T00:00:00Z' }];
    const items = shapeBankQueries(rows, META, TODAY);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('info');
  });

  it('stays silent for fresh unanswered queries', () => {
    const rows: BankQueryCountRow[] = [{ company_id: 'c1', replied: 0, awaiting: 1, oldest_sent: '2026-06-10T12:00:00Z' }];
    expect(shapeBankQueries(rows, META, TODAY)).toHaveLength(0);
  });

  it('drops rows whose company is not in meta (tenant safety)', () => {
    const rows: BankQueryCountRow[] = [{ company_id: 'other', replied: 5, awaiting: 0, oldest_sent: null }];
    expect(shapeBankQueries(rows, META, TODAY)).toHaveLength(0);
  });
});
```

Check the real `CompanyMeta` field names in `bureauWorkTypes.ts:23` before finalizing the META literal — use its actual shape, not the cast above, if it's small.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run tests/unit/services/bureau/bankQuerySignal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * WhatsApp bank-tx query signal for the /bureau cockpit and /home feed.
 *
 * TENANT SAFETY: runs on the RLS-bypassing @/lib/neon pool. The query filters
 * company_id = ANY(${companyIds}); companyIds is bureau-derived by the caller.
 * The pure shaper drops rows whose company_id is not in the supplied meta map.
 */
import { sql } from '@/lib/neon';
import type { WorkItem, CompanyMeta } from './bureauWorkTypes';

export interface BankQueryCountRow {
  company_id: string;
  replied: number;
  awaiting: number;
  oldest_sent: string | Date | null;
}

const STALE_DAYS = 3;
const MS_PER_DAY = 86_400_000;

export function shapeBankQueries(
  rows: BankQueryCountRow[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of rows) {
    const m = meta.get(r.company_id);
    if (!m) continue;
    const replied = Number(r.replied) || 0;
    const awaiting = Number(r.awaiting) || 0;
    if (replied > 0) {
      items.push({
        bureauId: m.bureau_id,
        bureauName: m.bureau_name,
        companyId: r.company_id,
        companyName: m.company_name,
        task: 'Client replies to review',
        detail: `${replied} WhatsApp ${replied === 1 ? 'reply' : 'replies'} to bank queries awaiting review`,
        dueAt: null,
        href: '/accounting/bank/queries',
        severity: 'due_soon',
      });
      continue;
    }
    if (awaiting > 0 && r.oldest_sent) {
      const oldest = r.oldest_sent instanceof Date ? r.oldest_sent : new Date(r.oldest_sent);
      const ageDays = Math.floor((today.getTime() - oldest.getTime()) / MS_PER_DAY);
      if (ageDays >= STALE_DAYS) {
        items.push({
          bureauId: m.bureau_id,
          bureauName: m.bureau_name,
          companyId: r.company_id,
          companyName: m.company_name,
          task: 'Awaiting client reply',
          detail: `${awaiting} bank ${awaiting === 1 ? 'query' : 'queries'} sent, oldest ${ageDays}d ago`,
          dueAt: null,
          href: '/accounting/bank/queries',
          severity: 'info',
        });
      }
    }
  }
  return items;
}

export async function bankQuerySignal(
  companyIds: string[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): Promise<WorkItem[]> {
  const rows = (await sql`
    SELECT company_id,
           COUNT(*) FILTER (WHERE status = 'replied')::int AS replied,
           COUNT(*) FILTER (WHERE status = 'sent')::int   AS awaiting,
           MIN(sent_at) FILTER (WHERE status = 'sent')    AS oldest_sent
    FROM bank_tx_queries
    WHERE company_id = ANY(${companyIds})
      AND status IN ('sent', 'replied')
    GROUP BY company_id
  `) as unknown as BankQueryCountRow[];
  return shapeBankQueries(rows, meta, today);
}
```

Match `WorkItem` field names exactly against `bureauWorkTypes.ts` (`bureauId`/`bureauName` — verify casing against `complianceSignal.ts:66-76` which uses `m.bureau_id` → `bureauId`).

- [ ] **Step 4: Register in the aggregator**

In `bureauWorkAggregatorService.ts` add the import next to `complianceSignal` and one line in the `Promise.all` block (~line 231):
```ts
      safeSignal('bankQueries', () => bankQuerySignal(companyIds, meta, today)),
```

- [ ] **Step 5: Run tests + bureau suite**

Run: `bunx vitest run tests/unit/services/bureau/ && bun run type-check`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/modules/bureau/services/bankQuerySignal.ts src/modules/bureau/services/bureauWorkAggregatorService.ts tests/unit/services/bureau/bankQuerySignal.test.ts
git commit -m "feat(bank-queries): cockpit signal for replied/stale client queries"
```

---

### Task 8: Compose modal + BankTxTable action

**Files:**
- Create: `src/components/accounting/BankTxQueryModal.tsx`
- Modify: `src/components/accounting/BankTxTable.tsx` (add `onAskClient?: (txId: string) => void` prop + button)
- Modify: `pages/accounting/bank-transactions/index.tsx` (wire modal)

No unit tests for UI components (repo norm) — verified in the browser pass.

- [ ] **Step 1: Build BankTxQueryModal**

Model the modal shell (overlay, close, toast) on `src/components/accounting/BankTxAttachmentsModal.tsx` — read it first and copy its conventions (styling vars like `var(--ff-text-tertiary)`, `apiFetch` usage, lucide icons). Behavior:

- Props: `{ tx: BankTx | null; onClose: () => void; onSent?: () => void }` (render nothing when `tx` is null). Import `BankTx` from wherever the table's types live (`src/components/accounting/bank-transactions` — check the actual export used by `BankTxTable.tsx:13`).
- On open (`useEffect` on `tx?.id`):
  - `apiFetch('/api/accounting/bank-tx-queries/settings')` → prefill phone input with `clientQueryWhatsapp`, keep `companyName`.
  - `apiFetch('/api/accounting/bank-tx-queries?bankTransactionId=' + tx.id)` → if any row has status `sent`/`replied`, show a warning banner: "Already asked on {sent_at date} — status {status}".
  - Prefill the message textarea with `composeBankTxQueryMessage({ companyName, txDate: tx.transactionDate?.slice(0,10) ?? '', description: tx.description ?? '', amount: tx.amount, reference: tx.reference }).body` — import the pure helper directly (`@/modules/accounting/services/capture/bankTxQueryMessage` — it has no server-only imports, safe for the client bundle). Check the actual `BankTx` field names (camelCase mapping) in the types file and use those.
- Fields: phone input (tel), message textarea (max 1000), checkbox "Save as this client's default number".
- Send button → `apiFetch('/api/accounting/bank-tx-queries', { method: 'POST', body: JSON.stringify({ bankTransactionId: tx.id, toNumber, message, saveAsDefault }) })`. On success: call `onSent?.()`, close. On failure: inline error with the server's message (the API returns the Twilio reason — e.g. "twilio env vars not configured" — show it verbatim so misconfiguration is visible, never swallowed).
- Unwrap responses as `json.data.…` (project rule: apiResponse wraps payloads in `data`; check how `apiFetch` callers in `BankTxAttachmentsModal.tsx` unwrap and copy that).
- Keep the file under 300 lines.

- [ ] **Step 2: Add the action to BankTxTable**

In `BankTxTable.tsx`:
- Add `onAskClient?: (txId: string) => void;` to the props interface (next to `onAttachments` ~line 112) and destructure it alongside (~line 184).
- Add a button next to EVERY `onAttachments` button occurrence (lines ~603, ~622, ~641 — the reviewed/excluded/new action sets; check each render branch):
```tsx
{onAskClient && (
  <button onClick={() => onAskClient(tx.id)} title="Ask client on WhatsApp"
    className="…same classes as the sibling Attachments button…">
    <MessageCircle size={14} />
  </button>
)}
```
Copy the exact className from the sibling Attachments button in each branch; import `MessageCircle` from `lucide-react`.

- [ ] **Step 3: Wire the modal in the page**

In `pages/accounting/bank-transactions/index.tsx`:
- Add state: `const [queryTx, setQueryTx] = useState<BankTx | null>(null);`
- Pass to the table (next to `onAttachments` ~line 326): `onAskClient={id => setQueryTx(transactions.find(t => t.id === id) ?? null)}`
- Render `<BankTxQueryModal tx={queryTx} onClose={() => setQueryTx(null)} onSent={() => setQueryTx(null)} />` next to the other modals (~line 373 area; if modals are grouped in a `BankTxModals` component, follow that grouping instead).
- Mind the 300-line cap on the page — if it's already near the cap, the modal render line is small; do not restructure the page.

- [ ] **Step 4: Verify build + lint**

Run: `bun run type-check && bun run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/BankTxQueryModal.tsx src/components/accounting/BankTxTable.tsx pages/accounting/bank-transactions/index.tsx
git commit -m "feat(bank-queries): Ask Client action + compose modal on bank transactions"
```

---

### Task 9: Resolution queue page + nav

**Files:**
- Create: `pages/accounting/bank/queries.tsx`
- Modify: `src/components/accounting/navSections/banking.ts`

- [ ] **Step 1: Build the page**

Model on `pages/accounting/bank/provisional.tsx` (AppLayout, apiFetch, toast, badge components — read it first). Content:

- Header: "Client Queries" + subtitle "WhatsApp queries to clients about bank transactions".
- Status filter tabs: Open (`sent`), Replied (`replied`), Resolved (`resolved`), All. Default tab: Replied (that's the actionable queue).
- Fetch `apiFetch('/api/accounting/bank-tx-queries' + (status ? `?status=${status}` : ''))`, unwrap `json.data`.
- Table rows: tx date, bank account, description, amount (use the page's `fmtZAR`-style helper), to_number, status badge, sent_at, reply_text (render multi-line, truncated with expand), attachment_count with a paperclip icon.
- Row actions:
  - "View slips" (when attachment_count > 0): reuse `BankTxAttachmentsModal` — read its props in `src/components/accounting/BankTxAttachmentsModal.tsx` and open it with the row's `bank_transaction_id`. If its props don't fit standalone use (e.g. it needs more than a txId + onClose), fall back to a link `View transaction →` pointing at `/accounting/bank-transactions`.
  - "Resolve" (status sent/replied): `apiFetch PATCH /api/accounting/bank-tx-queries/{id}` body `{action:'resolve'}`, then refetch.
  - "Cancel" (status sent only): same with `{action:'cancel'}`, with a confirm.
- After any mutation, refetch the list. NOTE the withAuth response-before-COMMIT race (the handler's response can flush before the tx commits): copy the `settle()` + one-retry pattern from `pages/payroll/parallel-run/index.tsx` `loadComparison` for the post-mutation refetch.
- Empty state per tab ("No replies waiting — all caught up").
- Handle `Date | string` shapes for timestamps (pg returns Date objects server-side, strings over JSON — over apiFetch they're strings; format defensively like `fmtDate` in provisional.tsx).
- Keep under 300 lines; extract a `QueryRow` subcomponent into the same file only if needed, or `src/components/accounting/bank/QueryRow.tsx` if over.

- [ ] **Step 2: Nav entry**

In `src/components/accounting/navSections/banking.ts`, add to the `Transactions` section after `Transfers`:
```ts
        { label: 'Client Queries', href: '/accounting/bank/queries' },
```

- [ ] **Step 3: Verify**

Run: `bun run type-check && bun run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add pages/accounting/bank/queries.tsx src/components/accounting/navSections/banking.ts
git commit -m "feat(bank-queries): resolution queue page + nav entry"
```

---

### Task 10: Module docs + full CI

**Files:**
- Modify: `src/modules/accounting/services/capture/.claude.md` (add the three new services + the inbound hook under "recent changes")
- Create: `pages/api/accounting/bank-tx-queries/.claude.md` (purpose / caller contract / main signatures / business rules)
- Mirror both as sibling `AGENTS.md` (copy content; check how existing siblings differ — they're usually verbatim copies)
- Modify: `src/modules/bureau/services/.claude.md` if it exists (new signal)

- [ ] **Step 1: Update docs**

Follow the structure of the existing `.claude.md` files in those directories (read them first). Key business rules to record:
- No Twilio send → no query row (fail-closed).
- Reply matching: company + normalized E.164, `sent` preferred over `replied`, newest first; second message appends.
- Media ≤2MB attaches to `bank_transaction_attachments`; larger media is captured but not attached (logged).
- `attachReplyMedia` trusts `findOpenQuery`'s company scoping (no re-verify).
- Statuses: sent → replied → resolved; sent → cancelled.

- [ ] **Step 2: Full CI gate**

Run: `bun run ci`
Expected: PASS. Known flake: rateLimit + cashFlowReport tests can TIMEOUT under machine load — if they fail, re-run those files in isolation before suspecting the code (see handoff 2026-06-11).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs(bank-queries): module docs for query loop services + API group"
```

---

## Post-implementation (session-level, NOT subagent tasks)

1. **Blind review:** `/review` with the full branch diff (context-free agents). Fix HIGH/MED, decline-with-receipts where wrong.
2. **Browser verification on dev** (`isaflow_dev`, Demo company, dev server from the worktree on a free port like :3215):
   - Apply mig 496 to dev.
   - Set a dummy `TWILIO_AUTH_TOKEN` in the dev env; seed a `bank_tx_queries` row directly in dev DB (outbound can't send without real creds — decision #2).
   - Simulate the client reply by POSTing a signed Twilio webhook payload (text-only, and with media via a stubbed/small data fetch — text-only is sufficient if media fetch can't be simulated; the attach path is unit-tested).
   - Verify: query flips to replied, reply_text visible on `/accounting/bank/queries`, Resolve works, signal appears on `/bureau` feed (requires a bureau link — if dev has 0 bureau_users, verify the signal via the `/api/home` work-items feed instead, or unit-test evidence suffices).
   - Verify the Ask Client modal renders, prefills, and surfaces the "twilio env vars not configured"-style failure inline when sending with dummy creds.
   - Reset dev DB rows after.
3. **PR** with the decision table; squash-merge after review; deploy per worktree recipe; verify endpoints 401 unauth + mig 496 applied.
4. **Full round-trip with a real phone** remains gated on `TWILIO_AUTH_TOKEN` + WABA — report this to Hein as the remaining "done when" evidence.
