// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { readThemeVar } from '@/lib/charts/readThemeVar';

const styles = (props: Record<string, string>) =>
  ({ getPropertyValue: (name: string) => props[name] ?? '' }) as unknown as CSSStyleDeclaration;

describe('readThemeVar', () => {
  beforeEach(() => { document.body.innerHTML = '<div class="font-sans" style="font-family: Georgia, serif"></div>'; });

  it('returns a defined variable as it is (the print page defines --ff-fig-font)', () => {
    expect(readThemeVar(styles({ '--ff-fig-font': '  "IBM Plex Sans", sans-serif ' }), '--ff-fig-font')).toBe('"IBM Plex Sans", sans-serif');
  });

  it('answers an undefined --ff-fig-font with the app face, never the monospace fallback', () => {
    const face = readThemeVar(styles({}), '--ff-fig-font');
    expect(face).toContain('Georgia');
    expect(face).not.toMatch(/monospace/);
  });

  it('leaves every other empty variable empty', () => {
    expect(readThemeVar(styles({}), '--ff-fav')).toBe('');
  });
});
