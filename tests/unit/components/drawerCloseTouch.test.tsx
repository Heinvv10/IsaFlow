// The shared Drawer's close X is the only way out on a phone, so it is a 44px square below lg.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Drawer } from '@/components/ui/Drawer';

afterEach(cleanup);

it('close X is a 44px square on phones and cannot be pushed off by a long title', () => {
  render(<Drawer open onClose={() => undefined} title="Invoice"><p>body</p></Drawer>);
  const x = screen.getByRole('button', { name: 'Close drawer' });
  expect(x.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']));
  expect(x.className.split(' ')).toContain('max-lg:shrink-0');
  const title = screen.getByRole('heading', { name: 'Invoice' });
  expect(title.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:min-w-0', 'max-lg:break-words']));
});
