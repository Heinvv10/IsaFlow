/**
 * Escape on an OPEN kit Select inside a Modal closes the list and nothing else (UI review L6): the Modal closes on
 * Escape, and a list's Escape bubbling to it lost every field the user had typed. On a closed trigger Escape still
 * reaches the Modal. Every key path: the trigger (a plain select), the list panel (a searchable one's search box), and
 * the clear button inside the trigger (a press on it released off it leaves focus there with the list open).
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';

const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }];

function Harness({ onClose, searchable, initial = null }: { onClose: () => void; searchable?: boolean; initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <Modal open onClose={onClose} title="Dialog">
      <Modal.Body><Select label="Letter" options={OPTIONS} value={value} onChange={setValue} searchable={searchable} clearable /></Modal.Body>
    </Modal>
  );
}
const trigger = () => screen.getByRole('combobox', { name: 'Letter' });

afterEach(cleanup);

it('a plain select: Escape on the open list closes the list, not the modal; Escape on the closed trigger closes the modal', () => {
  const onClose = vi.fn();
  render(<Harness onClose={onClose} />);
  fireEvent.keyDown(trigger(), { key: 'Enter' });
  expect(screen.getByRole('listbox')).toBeTruthy();
  fireEvent.keyDown(trigger(), { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(trigger(), { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('a searchable select: Escape in its search box closes the list, not the modal', () => {
  const onClose = vi.fn();
  render(<Harness onClose={onClose} searchable />);
  fireEvent.keyDown(trigger(), { key: 'Enter' });
  const listbox = screen.getByRole('listbox');
  const search = document.body.querySelector<HTMLInputElement>('input[type="text"], input[type="search"]')!;
  expect(search).toBeTruthy();
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(listbox.isConnected && screen.queryByRole('listbox')).toBeFalsy();
  expect(onClose).not.toHaveBeenCalled();
});

it('focus on the clear button with the list open: Escape closes the list, not the modal', () => {
  const onClose = vi.fn();
  render(<Harness onClose={onClose} initial="a" />);
  fireEvent.keyDown(trigger(), { key: 'Enter' });
  expect(screen.getByRole('listbox')).toBeTruthy();
  const clear = screen.getByRole('button', { name: 'Clear selection' });
  clear.focus();
  fireEvent.keyDown(clear, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});
