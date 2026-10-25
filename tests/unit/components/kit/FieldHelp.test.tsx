import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MoneyField } from '@/components/ui/MoneyField';
import { DateField } from '@/components/ui/DateField';
import { FormSection } from '@/components/ui/FormSection';
import { ExplainDrawer } from '@/components/ui/ExplainDrawer';

const HELP = { text: 'The amount before VAT, in rand.', href: 'https://help.isaflow.co.za/amounts' };

const tip = (): HTMLElement => document.querySelector('[role="tooltip"]') as HTMLElement;
const help = (href?: string) => ({ text: 'Help text.', href });
const field = (href?: string) => (
  <MoneyField label="Amount" value={null} onChange={() => undefined} help={help(href)} />
);

describe('field help on MoneyField and DateField', () => {
  it.each([
    ['MoneyField', 'Amount', <MoneyField key="m" label="Amount" value={null} onChange={() => undefined} help={HELP} />],
    ['DateField', 'Amount', <DateField key="d" label="Amount" value={null} onChange={() => undefined} help={HELP} />],
  ])('%s: button with an aria-label, tooltip hidden until focus', (_n, subject, ui) => {
    render(ui);
    const button = screen.getByRole('button', { name: `Help: ${subject}` });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect((tip().parentElement as HTMLElement).hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.focus(button);
    expect((tip().parentElement as HTMLElement).hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(tip().textContent).toContain(HELP.text);
  });

  it('links the help text to the input with aria-describedby (even while hidden)', () => {
    render(<MoneyField label="Amount" value={null} onChange={() => undefined} help={HELP} />);
    const input = screen.getByLabelText('Amount');
    expect((tip().parentElement as HTMLElement).hidden).toBe(true);
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(tip().id);
    expect(document.getElementById(tip().id)?.textContent).toContain(HELP.text);
  });

  it('keeps the help linked alongside the error and the echo', () => {
    render(<MoneyField label="Amount" value={null} onChange={() => undefined} help={HELP} error="Too much." />);
    const input = screen.getByLabelText('Amount');
    const ids = input.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(ids).toContain(tip().id);
    expect(ids).toContain(screen.getByRole('alert').id);
  });

  it('has no help button and no extra describedby entry without help', () => {
    render(<MoneyField label="Amount" value={null} onChange={() => undefined} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(screen.getByLabelText('Amount').getAttribute('aria-describedby')).toBeNull();
  });

  it('Escape closes the tooltip and keeps focus on the button', () => {
    render(<DateField label="Date" value={null} onChange={() => undefined} help={HELP} />);
    const button = screen.getByRole('button', { name: 'Help: Date' });
    button.focus();
    fireEvent.focus(button);
    expect((tip().parentElement as HTMLElement).hidden).toBe(false);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect((tip().parentElement as HTMLElement).hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it('Escape closes the tooltip without also closing a dialog around it', () => {
    const onClose = vi.fn();
    render(
      <>
        <MoneyField label="Amount" value={null} onChange={() => undefined} help={HELP} />
        <ExplainDrawer open onClose={onClose} explanation={{ title: 'Why', lines: [] }} />
      </>,
    );
    const button = screen.getByRole('button', { name: 'Help: Amount' });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect((tip().parentElement as HTMLElement).hidden).toBe(false);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect((tip().parentElement as HTMLElement).hidden).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens on hover and closes when the pointer leaves', () => {
    render(<MoneyField label="Amount" value={null} onChange={() => undefined} help={HELP} />);
    const wrapper = screen.getByRole('button', { name: 'Help: Amount' }).parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect((tip().parentElement as HTMLElement).hidden).toBe(false);
    fireEvent.mouseLeave(wrapper);
    expect((tip().parentElement as HTMLElement).hidden).toBe(true);
  });

  it('closes when focus leaves, but not when it moves to the Learn more link', () => {
    render(<MoneyField label="Amount" value={null} onChange={() => undefined} help={HELP} />);
    const button = screen.getByRole('button', { name: 'Help: Amount' });
    fireEvent.focus(button);
    const link = screen.getByRole('link', { name: /Learn more/ });
    fireEvent.blur(button, { relatedTarget: link });
    expect((tip().parentElement as HTMLElement).hidden).toBe(false);
    fireEvent.blur(link, { relatedTarget: screen.getByLabelText('Amount') });
    expect((tip().parentElement as HTMLElement).hidden).toBe(true);
  });

  it('renders the Learn more link; external links open in a new tab and say so', () => {
    render(<MoneyField label="Amount" value={null} onChange={() => undefined} help={HELP} />);
    fireEvent.focus(screen.getByRole('button', { name: 'Help: Amount' }));
    const link = screen.getByRole('link', { name: 'Learn more (opens in a new tab)' });
    expect(link.getAttribute('href')).toBe(HELP.href);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('an in-app link stays in the tab; no href means no link', () => {
    const { unmount } = render(
      <MoneyField label="Amount" value={null} onChange={() => undefined} help={{ text: 'x', href: '/help/amounts' }} />,
    );
    fireEvent.focus(screen.getByRole('button', { name: 'Help: Amount' }));
    const link = screen.getByRole('link', { name: 'Learn more' });
    expect(link.getAttribute('target')).toBeNull();
    unmount();
    render(<MoneyField label="Amount" value={null} onChange={() => undefined} help={{ text: 'x' }} />);
    fireEvent.focus(screen.getByRole('button', { name: 'Help: Amount' }));
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the tooltip holds text only; the link is beside it', () => {
  it('role=tooltip has no interactive descendants, the link is a sibling in the popover', () => {
    render(field('https://help.isaflow.co.za/x'));
    fireEvent.focus(screen.getByRole('button', { name: 'Help: Amount' }));
    expect(tip().querySelector('a, button, input')).toBeNull();
    expect(tip().textContent).toBe('Help text.');
    const link = screen.getByRole('link', { name: /Learn more/ });
    expect(tip().contains(link)).toBe(false);
    expect((tip().parentElement as HTMLElement).contains(link)).toBe(true);
  });

  it('Esc with focus on the link closes the popover and puts focus back on the (i) button', () => {
    render(field('https://help.isaflow.co.za/x'));
    const button = screen.getByRole('button', { name: 'Help: Amount' });
    fireEvent.focus(button);
    const link = screen.getByRole('link', { name: /Learn more/ });
    link.focus();
    expect(document.activeElement).toBe(link);
    fireEvent.keyDown(link, { key: 'Escape' });
    expect((tip().parentElement as HTMLElement).hidden).toBe(true);
    expect(document.activeElement).toBe(button);
  });
});

describe('Learn more only links to safe targets', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    '\tjavascript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/x',
    '/\\evil.example/x',
    'https://',
    'ftp://example.com/x',
    'mailto:a@b.co',
    'help/amounts',
    '',
    'https://exa mple.com',
    'http://help.isaflow.co.za/x',
    'HTTP://HELP.ISAFLOW.CO.ZA/',
    'http://localhost:3000/a',
  ])('renders no link for %j', (href) => {
    render(field(href));
    fireEvent.focus(screen.getByRole('button', { name: 'Help: Amount' }));
    expect(document.querySelector('a')).toBeNull();
    expect(tip().textContent).toBe('Help text.');
  });

  it.each(['https://help.isaflow.co.za/x?y=1#z', 'HTTPS://HELP.ISAFLOW.CO.ZA/', '/help/amounts', '/'])(
    'renders a link for %j',
    (href) => {
      render(field(href));
      fireEvent.focus(screen.getByRole('button', { name: 'Help: Amount' }));
      expect(document.querySelector('a')?.getAttribute('href')).toBe(href);
    },
  );
});

describe('field help on FormSection', () => {
  it('the help button is named for the section and the text describes the region', () => {
    render(
      <FormSection title="Line items" help={{ text: 'One row per product or service.', href: 'https://help.isaflow.co.za/lines' }}>
        body
      </FormSection>,
    );
    const button = screen.getByRole('button', { name: 'Help: Line items' });
    const region = screen.getByRole('region', { name: /Line items/ });
    expect((tip().parentElement as HTMLElement).hidden).toBe(true);
    expect(region.getAttribute('aria-describedby')).toBe(tip().id);
    fireEvent.focus(button);
    expect((tip().parentElement as HTMLElement).hidden).toBe(false);
    expect(tip().textContent).toContain('One row per product or service.');
    fireEvent.keyDown(button, { key: 'Escape' });
    expect((tip().parentElement as HTMLElement).hidden).toBe(true);
  });

  it('keeps the heading text clean of the help button', () => {
    render(<FormSection title="Notes" help={{ text: 'Shown on the invoice.' }}>x</FormSection>);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Notes');
  });

  it('without help there is no describedby', () => {
    render(<FormSection title="Notes">x</FormSection>);
    expect(screen.getByRole('region').getAttribute('aria-describedby')).toBeNull();
  });
});
