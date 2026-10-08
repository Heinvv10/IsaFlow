/**
 * R-035 follow-up, PR A (goal §3): an Enforce switch whose type has no ACTIVE
 * rule gates nothing, so the panel says so beside it — and stops saying so once
 * a rule exists. The legacy-rule warnings are kept.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { json, rule } from '../helpers/approvalRulesServe';
import ApprovalsPage from '@/../pages/accounting/approvals';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

afterEach(() => { cleanup(); });

const WARNING = 'No active rule for this type — turning this on gates nothing.';
const ENFORCEABLE = ['supplier_invoice', 'customer_credit_note', 'supplier_credit_note', 'manual_journal'];

function answer(rules: ReturnType<typeof rule>[], legacyCreditNoteRules = 0) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/approval-rules')) return json({ success: true, data: { items: rules, actorRole: 'owner' } });
    if (path.startsWith('/api/accounting/approval-enforcement')) {
      return json({ success: true, data: { items: [], enforceable: ENFORCEABLE, legacyCreditNoteRules,
        legacyPaymentRules: 0, legacyJournalRules: 0, preview: {} } });
    }
    return json({ success: true, data: { items: [] } });
  });
}

/** The row of one switch: its label's parent holds the switch and every note beside it. */
const rowOf = async (label: RegExp) => (await screen.findByRole('checkbox', { name: label })).closest('label')!.parentElement!;

async function openRules() {
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /^rules$/i }));
}

it('warns beside each switch whose type has no active rule, and only those', async () => {
  answer([
    rule({ id: 'a', documentType: 'supplier_invoice' }),
    rule({ id: 'b', documentType: 'customer_credit_note', isActive: false }),
  ]);
  await openRules();
  expect(await rowOf(/enforce supplier invoice approvals/i)).not.toHaveTextContent(WARNING);
  expect(await rowOf(/enforce customer credit note approvals/i)).toHaveTextContent(WARNING);
  expect(await rowOf(/enforce supplier credit note approvals/i)).toHaveTextContent(WARNING);
  expect(await rowOf(/enforce manual journal approvals/i)).toHaveTextContent(WARNING);
  expect(screen.getAllByText(WARNING)).toHaveLength(3);
});

it('says nothing once every type has an active rule', async () => {
  answer(ENFORCEABLE.map((documentType, i) => rule({ id: `r${i}`, documentType })));
  await openRules();
  await rowOf(/enforce manual journal approvals/i);
  expect(screen.queryByText(WARNING)).toBeNull();
});

it('keeps the legacy credit-note warning beside the new one', async () => {
  answer([rule({ id: 'a', documentType: 'credit_note' })], 1);
  await openRules();
  const row = await rowOf(/enforce customer credit note approvals/i);
  expect(row).toHaveTextContent(WARNING);
  expect(row).toHaveTextContent('1 legacy credit-note rule governs nothing — re-create it as a customer/supplier credit-note rule');
});

it('does not claim a type has no rule while the rules could not be loaded', async () => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/approval-rules')) return json({ success: false, error: { message: 'Rules unavailable' } }, 503);
    if (path.startsWith('/api/accounting/approval-enforcement')) {
      return json({ success: true, data: { items: [], enforceable: ENFORCEABLE, preview: {} } });
    }
    return json({ success: true, data: { items: [] } });
  });
  await openRules();
  await rowOf(/enforce manual journal approvals/i);
  expect(screen.queryByText(WARNING)).toBeNull();
});

describe('coupled payment switches (D1): the note never says something false', () => {
  const PAYMENTS = ['supplier_payment', 'payment_batch'];
  function answerPayments(rules: ReturnType<typeof rule>[]) {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
      const path = String(url);
      if (path.startsWith('/api/accounting/approval-rules')) return json({ success: true, data: { items: rules, actorRole: 'owner' } });
      if (path.startsWith('/api/accounting/approval-enforcement')) {
        return json({ success: true, data: { items: [], enforceable: PAYMENTS, legacyCreditNoteRules: 0,
          legacyPaymentRules: 0, legacyJournalRules: 0, preview: {} } });
      }
      return json({ success: true, data: { items: [] } });
    });
  }

  it('neither type has an active rule: both say they gate nothing', async () => {
    answerPayments([rule({ id: 'x', documentType: 'payment_batch', isActive: false })]);
    await openRules();
    expect(await rowOf(/enforce supplier payment approvals/i)).toHaveTextContent(WARNING);
    expect(await rowOf(/enforce payment batch approvals/i)).toHaveTextContent(WARNING);
    expect(screen.queryByText(/gates only/)).toBeNull();
  });

  it('only the batch type has a rule: the payment switch says it gates only payment batches', async () => {
    answerPayments([rule({ id: 'b', documentType: 'payment_batch' })]);
    await openRules();
    const payment = await rowOf(/enforce supplier payment approvals/i);
    expect(payment).toHaveTextContent('No active rule for this type — turning this on gates only payment batches.');
    expect(payment).not.toHaveTextContent(WARNING);
    expect(await rowOf(/enforce payment batch approvals/i)).not.toHaveTextContent('No active rule');
  });

  it('only the payment type has a rule: the batch switch says it gates only supplier payments', async () => {
    answerPayments([rule({ id: 'p', documentType: 'supplier_payment' })]);
    await openRules();
    const batch = await rowOf(/enforce payment batch approvals/i);
    expect(batch).toHaveTextContent('No active rule for this type — turning this on gates only supplier payments.');
    expect(batch).not.toHaveTextContent(WARNING);
    expect(await rowOf(/enforce supplier payment approvals/i)).not.toHaveTextContent('No active rule');
  });
});
