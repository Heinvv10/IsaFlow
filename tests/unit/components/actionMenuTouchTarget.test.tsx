/** The kebab trigger is 36px on desktop and 44px below lg (mobile audit M07 touch targets). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ActionMenu } from '@/components/ui/ActionMenu';

afterEach(cleanup);

describe('ActionMenu trigger', () => {
  it('is 44px below lg and 36px from lg', () => {
    render(<ActionMenu items={[{ label: 'Cancel', onClick: vi.fn() }]} triggerLabel="More invoice actions" />);
    const cls = screen.getByRole('button', { name: 'More invoice actions' }).className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['h-9', 'w-9', 'max-lg:h-11', 'max-lg:w-11']));
  });
});
