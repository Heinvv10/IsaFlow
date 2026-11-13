import { describe, it, expect } from 'vitest';
import { PATTERNS } from '@/modules/accounting/services/ask/askIntents';
import { FILLER_WORDS, isKnownWord, leftoverWords } from '@/modules/accounting/services/ask/askVocabulary';

/** Pieces of a pattern's source that are regex syntax or optional endings, not words. */
const FRAGMENTS = new Set(['ing', 'cod', 'e', 'ed', 'not']) // 'not' appears in patterns only inside the negated-allocation unit;

function wordsOf(re: RegExp): string[] {
  const src = re.source.replace(/\(\?![^)]*\)/g, ' ').replace(/\\[a-zA-Z]/g, ' ');
  return (src.match(/[a-z0-9]+/g) ?? []).filter((w) => !FRAGMENTS.has(w));
}

describe('vocabulary covers the patterns', () => {
  it('every literal word in every intent pattern is accounted for (a word added to a pattern must be added to the vocabulary)', () => {
    const missing = PATTERNS.flatMap(([id, re]) => wordsOf(re).filter((w) => !isKnownWord(w)).map((w) => `${id}:${w}`));
    expect(missing).toEqual([]);
  });
  it('the check can fail: a made-up word is not known', () => {
    expect(isKnownWord('zzzword')).toBe(false);
  });
});

describe('the filler list is pinned', () => {
  const EXPECTED = [
    'what', 'whats', 'is', 'are', 'was', 'were', 'my', 'our', 'mine', 'i', 'we', 'me', 'us', 'you',
    'your', 'the', 'a', 'an', 'for', 'in', 'of', 'on', 'at', 'as', 'to', 'do', 'does', 'did',
    'can', 'could', 'how', 'much', 'many', 'please', 'show', 'tell', 'give', 'list', 'it', 'its', 'there', 'been',
    'be', 'have', 'has', 'had', 'any', 'all', 'still', 'yet', 'need', 'needs', 'so', 'far', 'right', 'just',
    'kindly', 'roughly', 'approximately', 'about', 'around', 'which', 'when', 'who', 'whom', 'with', 'and', 'or', 'plus', 'vs',
    'versus', 'than', 'due', 'now', 'currently', 'total', 'totals', 'number', 'count', 'get', 'got', 'pay', 'paid', 'owed',
    'amount', 'figure', 'overall', 'company', 'business', 'thanks', 'thank', 'moment', 'return', 'sheet', 'statement', 'account', 'accounts', 'am',
    'make', 'made', 'making', 'earn', 'earned', 'earning', 'earnings', 'see', 'look', 'check', 'also', 'really', 'actually', 'doing',
    'done', 'being', 'little', 'bit', 'quick', 'quickly', 'vendor', 'vendors', 'looking', 'looks'];
  it.each(EXPECTED)('"%s" is filler, not a leftover', (w) => {
    expect(leftoverWords(w)).toEqual([]);
    expect(FILLER_WORDS).toContain(w);
  });
  it('the list has no words beyond the pinned ones (a new filler word is a decision)', () => {
    expect([...FILLER_WORDS].sort()).toEqual([...EXPECTED].sort());
  });
});
