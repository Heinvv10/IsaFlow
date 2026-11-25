// The migration wizards' shared "Download CSV Template" button is 44px on phones (it serves six migration pages).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemplateDownloadCard } from '../../../src/components/accounting/migration/TemplateDownloadCard';

afterEach(cleanup);

describe('Template download card on touch', () => {
  it('makes the download button 44px on phones', () => {
    render(<TemplateDownloadCard step="opening-balances" onError={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Download CSV Template/ }).className.split(' ')).toContain('max-lg:min-h-11');
  });
});
