import { describe, it, expect } from 'vitest';
import { askRowPlacement } from '@/components/layout/askQuery';

describe('askRowPlacement: auxiliary-verb openers', () => {
  it.each(['are my total assets high', 'do I owe any vat', 'can I see my profit this month'])('%s: a real question, first', (q) => {
    expect(askRowPlacement(q)).toBe('first');
  });
  it.each(['do not', 'is', 'can reports', 'does nothing', 'are we there'])('%s: could be a page search, last', (q) => {
    expect(askRowPlacement(q)).not.toBe('first');
  });
});

describe('askRowPlacement', () => {
  it.each(['who owes me money', 'what was profit last month', 'How much cash do I have?', 'is my vat due', 'how many bank transactions need allocating', 'what is the weather', 'cash in the bank?'])('%s: a question, its row first', (q) => {
    expect(askRowPlacement(q)).toBe('first');
  });
  it.each(['profit loss', 'aged debtors', 'vat return', 'cash in the bank'])('%s: an intent phrase that is also a page search, its row last', (q) => {
    expect(askRowPlacement(q)).toBe('last');
  });
  it.each(['vat', 'ab', 'new invoice', 'employee thandi', ''])('%s: a page search, no row', (q) => {
    expect(askRowPlacement(q)).toBeNull();
  });
});
