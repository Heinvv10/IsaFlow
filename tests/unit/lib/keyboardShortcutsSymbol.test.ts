import { describe, expect, it } from 'vitest';
import { matchesShortcut, parseShortcut } from '@/lib/keyboard-shortcuts';

type Init = { key: string; shiftKey?: boolean; ctrlKey?: boolean };
/** matchesShortcut reads only these flags, so a plain object stands in for the DOM event (this project is node-env). */
const key = (init: Init) =>
  ({ metaKey: false, altKey: false, shiftKey: false, ctrlKey: false, ...init }) as unknown as KeyboardEvent;

describe('matchesShortcut: symbol keys', () => {
  it('"?" matches the key press a real keyboard sends (Shift held), and one sent without Shift', () => {
    const q = parseShortcut('?');
    expect(matchesShortcut(key({ key: '?', shiftKey: true }), q)).toBe(true);
    expect(matchesShortcut(key({ key: '?' }), q)).toBe(true);
  });
  it('still refuses a different key and a held Ctrl', () => {
    const q = parseShortcut('?');
    expect(matchesShortcut(key({ key: '/', shiftKey: true }), q)).toBe(false);
    expect(matchesShortcut(key({ key: '?', ctrlKey: true }), q)).toBe(false);
  });
  it('letters keep the exact Shift check: Shift+K is not "k", and ctrl+k is not ctrl+shift+k', () => {
    expect(matchesShortcut(key({ key: 'K', shiftKey: true }), parseShortcut('k'))).toBe(false);
    expect(matchesShortcut(key({ key: 'k', ctrlKey: true, shiftKey: true }), parseShortcut('ctrl+k'))).toBe(false);
    expect(matchesShortcut(key({ key: 'k', ctrlKey: true }), parseShortcut('ctrl+k'))).toBe(true);
  });
});
