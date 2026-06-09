import { describe, it, expect } from 'vitest';
import { resolveBankTxKey } from '@/components/accounting/bankTxKeyboard';

describe('resolveBankTxKey', () => {
  const row = { isEditingCell: false, canAccept: true };

  it('navigates with arrows', () => {
    expect(resolveBankTxKey('ArrowDown', row)).toBe('next');
    expect(resolveBankTxKey('ArrowUp', row)).toBe('prev');
  });

  it('Enter accepts when the row has a selected allocation', () => {
    expect(resolveBankTxKey('Enter', { isEditingCell: false, canAccept: true })).toBe('accept');
  });

  it('Enter edits when the row has no selected allocation', () => {
    expect(resolveBankTxKey('Enter', { isEditingCell: false, canAccept: false })).toBe('edit');
  });

  it('maps the hotkeys (case-insensitive)', () => {
    expect(resolveBankTxKey('e', row)).toBe('edit');
    expect(resolveBankTxKey('E', row)).toBe('edit');
    expect(resolveBankTxKey('x', row)).toBe('exclude');
    expect(resolveBankTxKey('X', row)).toBe('exclude');
    expect(resolveBankTxKey('s', row)).toBe('split');
    expect(resolveBankTxKey('S', row)).toBe('split');
  });

  it('ignores unmapped keys', () => {
    expect(resolveBankTxKey('a', row)).toBeNull();
    expect(resolveBankTxKey('Tab', row)).toBeNull();
  });

  it('while editing a cell, only Escape is intercepted (returns blur-to-row); everything else is native', () => {
    const editing = { isEditingCell: true, canAccept: true };
    expect(resolveBankTxKey('Escape', editing)).toBe('blur-to-row');
    expect(resolveBankTxKey('Enter', editing)).toBeNull();
    expect(resolveBankTxKey('e', editing)).toBeNull();
    expect(resolveBankTxKey('x', editing)).toBeNull();
    expect(resolveBankTxKey('ArrowDown', editing)).toBeNull();
  });
});
