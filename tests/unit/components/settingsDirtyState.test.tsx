// W3: Company Settings is dirty only while the form differs from what was last loaded or saved.
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { settingsSnapshot, useSettingsDirty } from '../../../src/components/accounting/settings/settingsSnapshot';

const form = (name: string, extra: Record<string, unknown> = {}) => ({ company: { name, vat: '4' }, docNumbers: [{ p: 'INV', n: 1 }], messages: { a: 'x' }, ...extra });

describe('settingsSnapshot', () => {
  it('ignores key order but sees every value', () => {
    expect(settingsSnapshot({ a: 1, b: { c: 2, d: 3 } })).toBe(settingsSnapshot({ b: { d: 3, c: 2 }, a: 1 }));
    expect(settingsSnapshot(form('A'))).not.toBe(settingsSnapshot(form('B')));
    expect(settingsSnapshot(form('A'))).not.toBe(settingsSnapshot(form('A', { messages: { a: 'y' } })));
  });
});

describe('useSettingsDirty', () => {
  const run = (initial: { snap: string; ready: boolean }) =>
    renderHook(({ snap, ready }) => useSettingsDirty(snap, ready), { initialProps: initial });

  it('is clean while loading and once loaded; dirty on an edit; clean again when reverted', () => {
    const loaded = settingsSnapshot(form('Acme'));
    const h = run({ snap: settingsSnapshot(form('')), ready: false });
    expect(h.result.current.dirty).toBe(false);
    h.rerender({ snap: loaded, ready: true });
    expect(h.result.current.dirty).toBe(false);
    h.rerender({ snap: settingsSnapshot(form('Acme 2')), ready: true });
    expect(h.result.current.dirty).toBe(true);
    h.rerender({ snap: loaded, ready: true });
    expect(h.result.current.dirty).toBe(false);
  });

  it('is clean after a save marks the edited state clean, and dirty again on the next edit', () => {
    const h = run({ snap: settingsSnapshot(form('Acme')), ready: true });
    const edited = settingsSnapshot(form('Acme 2'));
    h.rerender({ snap: edited, ready: true });
    expect(h.result.current.dirty).toBe(true);
    act(() => h.result.current.markClean(edited));
    expect(h.result.current.dirty).toBe(false);
    h.rerender({ snap: settingsSnapshot(form('Acme 3')), ready: true });
    expect(h.result.current.dirty).toBe(true);
  });

  it('a reload (ready drops then returns) takes a fresh baseline', () => {
    const h = run({ snap: settingsSnapshot(form('Acme')), ready: true });
    h.rerender({ snap: settingsSnapshot(form('Acme')), ready: false });
    h.rerender({ snap: settingsSnapshot(form('Server edit')), ready: true });
    expect(h.result.current.dirty).toBe(false);
  });
});
