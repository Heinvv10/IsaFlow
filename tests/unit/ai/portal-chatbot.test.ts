/**
 * TDD: AI Client Portal Chatbot Tests
 * RED phase.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyClientQuery,
  buildClientChatPrompt,
  parseClientChatResponse,
  buildClientContext,
  sanitizeClientResponse,
  type ClientContext,
  type ChatResponse,
  type ClientQueryType,
} from '@/modules/accounting/services/portalChatbotService';

// ═══════════════════════════════════════════════════════════════════════════
// QUERY CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Client Query Classification', () => {
  it('detects balance inquiry', () => { expect(classifyClientQuery("What's my balance?")).toBe('balance'); });
  it('detects invoice query', () => { expect(classifyClientQuery('Show my invoices')).toBe('invoices'); });
  it('detects payment query', () => { expect(classifyClientQuery('When was my last payment?')).toBe('payments'); });
  it('detects statement request', () => { expect(classifyClientQuery('Can I get a statement?')).toBe('statement'); });
  it('detects VAT query', () => { expect(classifyClientQuery('When is my next VAT return due?')).toBe('tax'); });
  it('detects general query', () => { expect(classifyClientQuery('Hello, how are you?')).toBe('general'); });
});

// ═══════════════════════════════════════════════════════════════════════════
// CHAT PROMPT
// ═══════════════════════════════════════════════════════════════════════════

describe('Client Chat Prompt', () => {
  const ctx: ClientContext = {
    clientName: 'John Smith',
    outstandingBalance: 15000,
    overdueAmount: 5000,
    lastPaymentDate: '2026-03-01',
    lastPaymentAmount: 10000,
    openInvoices: 3,
    companyName: 'IsaFlow Pty Ltd',
  };

  it('includes client name', () => {
    const prompt = buildClientChatPrompt('Hi', ctx);
    expect(prompt).toContain('John Smith');
  });

  it('includes balance info', () => {
    const prompt = buildClientChatPrompt('What do I owe?', ctx);
    expect(prompt).toContain('15'); // R15,000 formatted
  });

  it('includes company name', () => {
    const prompt = buildClientChatPrompt('test', ctx);
    expect(prompt).toContain('IsaFlow');
  });

  it('includes user question', () => {
    const prompt = buildClientChatPrompt('When is my next payment due?', ctx);
    expect(prompt).toContain('next payment due');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════

describe('Chat Response Parsing', () => {
  it('parses JSON response', () => {
    const r = parseClientChatResponse('{"message":"Your balance is R15,000","action":null}');
    expect(r).toBeDefined();
    expect(r!.message).toContain('15,000');
  });

  it('handles plain text', () => {
    const r = parseClientChatResponse('Your outstanding balance is R15,000.');
    expect(r).toBeDefined();
    expect(r!.message).toContain('R15,000');
  });

  it('detects action suggestions', () => {
    const r = parseClientChatResponse('{"message":"Here is your statement.","action":"download_statement"}');
    expect(r!.action).toBe('download_statement');
  });

  it('returns null for empty', () => {
    expect(parseClientChatResponse('')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT BUILDING
// ═══════════════════════════════════════════════════════════════════════════

describe('Client Context Building', () => {
  it('formats context string with ZAR', () => {
    const ctx = buildClientContext({
      clientName: 'Test', outstandingBalance: 25000, overdueAmount: 0,
      lastPaymentDate: '2026-03-01', lastPaymentAmount: 5000, openInvoices: 2, companyName: 'Co',
    });
    expect(ctx).toContain('R');
    expect(ctx).toContain('25');
    expect(ctx).toContain('2 open invoice');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE SANITIZATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Response Sanitization', () => {
  it('removes internal system references', () => {
    const clean = sanitizeClientResponse('Your balance in table customer_invoices is R15,000');
    expect(clean).not.toContain('customer_invoices');
  });

  it('removes SQL references', () => {
    const clean = sanitizeClientResponse('Based on SELECT * FROM invoices, your balance is R5,000');
    expect(clean).not.toContain('SELECT');
  });

  it('preserves normal financial text', () => {
    const clean = sanitizeClientResponse('Your outstanding balance is R15,000. Next payment is due on 2026-04-01.');
    expect(clean).toContain('R15,000');
    expect(clean).toContain('2026-04-01');
  });
});
