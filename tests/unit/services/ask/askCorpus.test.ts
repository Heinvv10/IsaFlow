/**
 * Realistic accountant questions, as a non-programmer types them (contractions, filler, loose grammar). Each line has the outcome it
 * must have: the intent it answers, or "refuse" for a real unsupported refinement, or "none" for not a question about the books.
 * A word missing from the vocabulary turns an answered line into a refusal, so this table is what keeps the filler list honest.
 */
import { describe, it, expect } from 'vitest';
import { parseQuestion } from '@/modules/accounting/services/ask/askIntents';

type Outcome = string; // an intent id, 'refuse' (leftover or unsupported), 'ambiguous', or 'none'

const CORPUS: ReadonlyArray<readonly [string, Outcome]> = [
  // Money owed to us
  ['Who owes me money?', 'owed_to_me'], ["who owes us money", 'owed_to_me'], ["what's outstanding from customers", 'owed_to_me'], ['how much are we owed?', 'owed_to_me'],
  ['how much do customers owe us', 'owed_to_me'], ["what do my debtors owe me", 'owed_to_me'], ['show me the debtors', 'owed_to_me'], ["what are my receivables", 'owed_to_me'],
  ['can you tell me who owes us', 'owed_to_me'], ['customers owing me money please', 'owed_to_me'], ['how much money are customers still owing us', 'owed_to_me'],
  ['who owes me money as at 15 October', 'owed_to_me'], ['who owes me money at the end of last month', 'owed_to_me'],
  // Money we owe
  ['Who do I owe?', 'i_owe'], ['how much do we owe suppliers', 'i_owe'], ["what do we owe our suppliers", 'i_owe'], ["what's owing to creditors", 'i_owe'], ['how much do we owe vendors?', 'i_owe'],
  ['show me my creditors', 'i_owe'], ['are we still owing our suppliers', 'i_owe'], ['what are my payables', 'i_owe'], ['how much do I owe', 'i_owe'], ['what do we owe', 'i_owe'], ['suppliers outstanding', 'i_owe'],
  // Bank and cash
  ['How much cash is in the bank?', 'cash'], ["what's our bank balance", 'cash'], ["what's the bank balance right now", 'cash'], ['how much money do we have in the bank', 'cash'],
  ['how much cash do we have', 'cash'], ["what's my cash position", 'cash'], ['cash balance please', 'cash'], ['how much money is in our bank accounts', 'cash'],
  ["what's the balance on our bank account", 'cash'], ['what is our account balance', 'cash'], ['bank balance', 'cash'],
  ['How many bank transactions need allocating?', 'bank_to_allocate'], ["how many bank lines haven't been allocated", 'bank_to_allocate'], ['unallocated bank transactions', 'bank_to_allocate'],
  ['how many transactions in the bank still need coding', 'bank_to_allocate'],
  // Profit, revenue, expenses
  ['What is my profit this month?', 'profit'], ['how much profit did we make this year', 'profit'], ["what's our profit", 'profit'], ["how much did we make last month", 'none'],
  ["what's our net profit for this financial year", 'profit'], ['did we make a profit last month', 'profit'], ['what is my profit for October', 'profit'],
  ["how's our profit looking this month", 'profit'], ['what is my net income year to date', 'profit'], ['are we making a loss this month', 'profit'], ['what was our profit in sept', 'profit'],
  ['what is my revenue this year', 'revenue'], ["what's our turnover this month", 'revenue'], ['how much did we sell last month', 'none'], ["what are our sales this year", 'revenue'],
  ['how much revenue have we earned this year', 'revenue'], ["what's the revenue for last month", 'revenue'], ['total sales last month', 'revenue'], ['revenue for the 2026 financial year', 'revenue'],
  ['What are my expenses last month?', 'expenses'], ["what have we spent this month", 'expenses'], ['how much did we spend last month', 'expenses'], ["what are our costs this year", 'expenses'],
  ["what's our total expenses for october", 'expenses'], ['how much are we spending', 'expenses'], ['what did we spend in jan', 'expenses'],
  ['what is my gross profit this month', 'profit'], ["what's our operating profit last month", 'profit'], ['cost of sales this year', 'expenses'],
  // Balance sheet
  ['What are my total assets?', 'assets'], ["what's our total assets", 'assets'], ['what do we own in total assets', 'assets'], ['total assets as at 30 September', 'assets'],
  ['What are my total liabilities?', 'liabilities'], ["what are our liabilities", 'liabilities'], ['total liabilities last month', 'liabilities'], ['how much are our total liabilities overall', 'liabilities'],
  // VAT, EMP201, payroll
  ['What VAT do I owe for October?', 'vat'], ["what's our VAT this period", 'vat'], ['how much vat do we owe', 'vat'], ['vat payable this period', 'vat'], ['what vat is payable this month', 'vat'],
  ["how much VAT is due to SARS", 'vat'], ["what's the vat for the current period", 'vat'], ['vat for oct', 'vat'], ['do we owe vat', 'vat'], ['is there vat to pay this period', 'vat'],
  ['What do I owe SARS for payroll in October?', 'emp201'], ["what's our PAYE for last month", 'emp201'], ['how much paye did we pay last month', 'emp201'], ['emp201 for last month', 'emp201'],
  ["what's our UIF and SDL", 'emp201'], ["how much do we owe sars for paye", 'emp201'],
  ['What did the last pay run cost?', 'last_pay_run'], ["what was last month's payroll", 'last_pay_run'], ['how much did payroll cost last month', 'last_pay_run'], ["what's the latest pay run", 'last_pay_run'],
  ['how much did we pay in salaries last month', 'none'],
  // Real refinements we do not support: refused, never answered with the plain figure
  ['profit by customer', 'refuse'], ['revenue from acme', 'refuse'], ['expenses for rent', 'refuse'], ['top 5 customers who owe me', 'refuse'], ['who owes me more than 5000', 'refuse'],
  ['profit before tax', 'refuse'], ['revenue excluding vat', 'refuse'], ['revenue net of vat', 'refuse'], ['profit this year vs last year', 'refuse'], ['profit last 30 days', 'refuse'],
  ['what is my profit in Q3', 'refuse'], ['expenses since march', 'refuse'], ['who owes me over 90 days', 'refuse'], ['profit for the period ending october', 'refuse'],
  // Ambiguous: asks which
  ['vat and profit', 'ambiguous'], ['gross profit and net profit', 'ambiguous'], ['total assets and liabilities', 'ambiguous'], ['revenue and expenses', 'ambiguous'],
  // Not about the books
  ['what is the weather', 'none'], ['hello', 'none'], ['delete all invoices', 'none'], ['post a journal for 500', 'none'],
];

function outcomeOf(q: string): Outcome {
  const p = parseQuestion(q);
  switch (p.kind) {
    // An unsupported window is refused by the answer layer, never answered with a default.
    case 'intent': return p.intent.period?.kind === 'unsupported' ? 'refuse' : p.intent.id;
    case 'ambiguous': return 'ambiguous';
    case 'periods': case 'leftover': case 'unsupported': return 'refuse';
    default: return 'none';
  }
}

describe('realistic accountant questions', () => {
  it('the corpus is big enough to mean something', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(80);
  });
  it.each(CORPUS.map(([q, o]) => [q, o]))('%s', (q, expected) => {
    expect(outcomeOf(q as string)).toBe(expected);
  });
});
