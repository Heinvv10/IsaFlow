import { describe, expect, it } from 'vitest';
import { computeReadingTime, countWords, WORDS_PER_MINUTE } from '@/lib/blog/readingTime';

const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('blog reading time', () => {
  it('counts prose and skips component props, imports and image URLs', () => {
    const mdx = [
      "import X from './x'",
      '## Two words',
      'One two three [link text](https://example.com/a-b-c).',
      '<Chart type="bar" title="Not counted" source="Nope" data={[{ label: "a", value: 1 }]} />',
      '![alt words](/blog/x/hero.webp)',
      '<Callout type="tip">Inside counts</Callout>',
    ].join('\n');
    // Two words (2) + One two three link text (5) + Inside counts (2)
    expect(countWords(mdx)).toBe(9);
  });

  it('rounds up to whole minutes with a one-minute floor', () => {
    expect(computeReadingTime('')).toBe(1);
    expect(computeReadingTime(words(WORDS_PER_MINUTE))).toBe(1);
    expect(computeReadingTime(words(WORDS_PER_MINUTE + 1))).toBe(2);
    expect(computeReadingTime(words(WORDS_PER_MINUTE * 5))).toBe(5);
  });

  it('uses the frontmatter override when given', () => {
    expect(computeReadingTime(words(WORDS_PER_MINUTE * 5), 12)).toBe(12);
  });
});
