/**
 * R-035 PR1: the approval gate every posting path will call (from PR2 on).
 * Nothing calls it yet; these tests call it directly.
 *
 * Cleared means: enforcement is on for (company, type), a rule matches, and an
 * APPROVED request exists for this document, in THIS company, whose digest is
 * the document's current digest and whose demanded rank is at least that of the
 * strictest rule matching today. Anything else is a refusal with a reason.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { getPoolForTests } from '../../src/lib/neon';
import {
  ApprovalRequiredError, assertApprovalCleared, evaluateApprovalGate,
} from '../../src/modules/accounting/services/gl/approvalGate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newCompany, plantBill, plantRule, type Bill } from './r035-approval.helpers';

assertDisposable();
const USER = '00000000-0000-0000-0000-00000000b035';
type Ctx = Parameters<typeof als.run>[0];

afterAll(async () => { await getPoolForTests().end(); });

interface Fx { c: PoolClient; company: string; bill: Bill }

async function inTx(fn: (fx: Fx) => Promise<void>, opts: { enforce?: boolean; rule?: string | null } = {}): Promise<void> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const company = await newCompany(client, []);
    const bill = await plantBill(client, company, USER);
    if (opts.rule !== null) await plantRule(client, company, opts.rule ?? 'owner');
    if (opts.enforce !== false) {
      await client.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'supplier_invoice',$2)", [company, USER]);
    }
    const ctx = { client, userId: USER, companyId: company, claims: {} } as unknown as Ctx;
    await als.run(ctx, () => fn({ c: client, company, bill }));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** A decided request row, planted the way decideRequest leaves one. */
async function plantRequest(fx: Fx, status: 'approved' | 'pending', opts: {
  company?: string; requiredRole?: string; digest?: 'current' | 'null' | 'other';
} = {}): Promise<string> {
  const company = opts.company ?? fx.company;
  const digest = opts.digest ?? 'current';
  const { rows } = await fx.c.query(
    `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role, document_digest)
     VALUES($1, 'supplier_invoice', $2, $3, $4, $5,
            CASE $6::TEXT WHEN 'current' THEN approval_document_digest($7, 'supplier_invoice', $2)
                          WHEN 'other' THEN md5('something else') END)
     RETURNING id`,
    [company, fx.bill.id, status, USER, opts.requiredRole ?? 'owner', digest, fx.company]);
  return rows[0].id as string;
}

const gate = (fx: Fx) => evaluateApprovalGate(fx.company, 'supplier_invoice', fx.bill.id);

describe('evaluateApprovalGate', () => {
  it('lets the document through when enforcement is off for the company', async () => {
    await inTx(async (fx) => { expect(await gate(fx)).toBeNull(); }, { enforce: false });
  });

  it('lets the document through when no active rule matches it', async () => {
    await inTx(async (fx) => { expect(await gate(fx)).toBeNull(); }, { rule: null });
  });

  it('refuses APPROVAL_REQUIRED with the demanded role when nothing was requested', async () => {
    await inTx(async (fx) => {
      expect(await gate(fx)).toMatchObject({ reason: 'APPROVAL_REQUIRED', requiredRole: 'owner', requestId: null });
    });
  });

  it('refuses APPROVAL_PENDING while a request awaits a decision', async () => {
    await inTx(async (fx) => {
      const requestId = await plantRequest(fx, 'pending');
      expect(await gate(fx)).toMatchObject({ reason: 'APPROVAL_PENDING', requiredRole: 'owner', requestId });
    });
  });

  it('clears on an approved request whose digest is the current one', async () => {
    await inTx(async (fx) => {
      await plantRequest(fx, 'approved');
      expect(await gate(fx)).toBeNull();
      await expect(assertApprovalCleared(fx.company, 'supplier_invoice', fx.bill.id)).resolves.toBeUndefined();
    });
  });

  it('refuses APPROVAL_STALE once the bill changes after approval, and clears again on revert', async () => {
    await inTx(async (fx) => {
      const requestId = await plantRequest(fx, 'approved');
      await fx.c.query('UPDATE supplier_invoices SET total_amount = 2000 WHERE id = $1', [fx.bill.id]);
      expect(await gate(fx)).toMatchObject({ reason: 'APPROVAL_STALE', requestId });
      await fx.c.query('UPDATE supplier_invoices SET total_amount = 1150 WHERE id = $1', [fx.bill.id]);
      expect(await gate(fx)).toBeNull();
    });
  });

  it('never clears on an approved request with a NULL digest (decided before migration 708)', async () => {
    await inTx(async (fx) => {
      await plantRequest(fx, 'approved', { digest: 'null' });
      expect(await gate(fx)).toMatchObject({ reason: 'APPROVAL_STALE' });
    });
  });

  it('ratchets: a manager-level approval does not clear once an owner rule governs', async () => {
    await inTx(async (fx) => {
      await plantRequest(fx, 'approved', { requiredRole: 'manager' });
      expect(await gate(fx)).toMatchObject({ reason: 'APPROVAL_REQUIRED', requiredRole: 'owner' });
    });
  });

  it("does not clear on an approved row in ANOTHER company naming this bill's id", async () => {
    await inTx(async (fx) => {
      const other = await newCompany(fx.c, []);
      await plantRequest(fx, 'approved', { company: other });
      expect(await gate(fx)).toMatchObject({ reason: 'APPROVAL_REQUIRED' });
    });
  });

  it("does not enforce on this company because ANOTHER company enabled enforcement", async () => {
    await inTx(async (fx) => {
      const other = await newCompany(fx.c, []);
      await fx.c.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'supplier_invoice',$2)", [other, USER]);
      expect(await gate(fx)).toBeNull();
    }, { enforce: false });
  });

  it('never clears a type with no digest definition yet (NULL current digest)', async () => {
    await inTx(async (fx) => {
      const customer = crypto.randomUUID();
      const noteId = crypto.randomUUID();
      await fx.c.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, fx.company, 'r035 gate']);
      await fx.c.query(
        `INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,credit_date,total_amount,created_by)
         VALUES($1,$2,$3,'customer',$4,CURRENT_DATE,100,$5)`, [noteId, fx.company, `CN-${noteId.slice(0, 6)}`, customer, USER]);
      await plantRule(fx.c, fx.company, 'owner', { documentType: 'credit_note' });
      await fx.c.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'credit_note',$2)", [fx.company, USER]);
      await fx.c.query(
        `INSERT INTO approval_requests(company_id, document_type, document_id, status, requested_by, required_role)
         VALUES($1, 'credit_note', $2, 'approved', $3, 'owner')`, [fx.company, noteId, USER]);
      expect(await evaluateApprovalGate(fx.company, 'credit_note', noteId)).toMatchObject({ reason: 'APPROVAL_STALE' });
    });
  });

  it('assertApprovalCleared throws ApprovalRequiredError carrying the reason and role', async () => {
    await inTx(async (fx) => {
      const error = await assertApprovalCleared(fx.company, 'supplier_invoice', fx.bill.id).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ApprovalRequiredError);
      expect(error).toMatchObject({ reason: 'APPROVAL_REQUIRED', requiredRole: 'owner', requestId: null });
      expect((error as Error).message).toMatch(/needs owner approval before it can be posted/);
    });
  });
});
