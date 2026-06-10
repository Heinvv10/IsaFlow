import { describe, it, expect } from 'vitest';
import { matchSourceToStrategy } from '@/modules/accounting/services/core/categorizationStrategy';

describe('matchSourceToStrategy', () => {
  it('maps matcher sources to persisted strategy tokens', () => {
    expect(matchSourceToStrategy('rule')).toBe('rule');
    expect(matchSourceToStrategy('pattern')).toBe('pattern');
    expect(matchSourceToStrategy('historical')).toBe('historical');
    expect(matchSourceToStrategy('llm')).toBe('llm');
  });
});
