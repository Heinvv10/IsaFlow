// CommentsPanel (M14): bodies render as TEXT, the write roles get the composer, only the author gets Edit/Delete,
// a mention picked from the list is sent as an id, a refused post shows its message and keeps the text.
import { fireEvent, render, screen, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let role = 'manager';
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role, activeCompany: { id: 'c1' } }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { CommentsPanel } from '@/components/accounting/comments/CommentsPanel';

const XSS = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });
const comment = (id: string, authorId: string, body: string) => ({
  id, recordType: 'customer_invoice', recordId: 'r1', body, authorId, authorName: authorId === 'me' ? 'Me Myself' : 'Olive Owner',
  mentions: [], createdAt: '2026-11-13T07:00:00Z', editedAt: null });
const READ = { comments: [comment('c1', 'me', XSS), comment('c2', 'olive', 'line one\nline two')], mentionable: [{ id: 'olive', name: 'Olive Owner' }] };
/** The kit Select (UXN): open "Mention a colleague", click the option. */
const choose = (name: string) => {
  fireEvent.click(screen.getByRole('combobox', { name: 'Mention a colleague' }));
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name }));
};
const writes: Array<{ method: string; body: unknown }> = [];

beforeEach(() => {
  role = 'manager'; writes.length = 0;
  vi.mocked(apiFetch).mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method) { writes.push({ method: init.method, body: JSON.parse(String(init.body ?? 'null')) }); return ok({ id: 'new' }, 201); }
    return ok(READ);
  });
});
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

it('renders a markup body as text: no element is created from it', async () => {
  const { container } = render(<CommentsPanel recordType="customer_invoice" recordId="r1" />);
  const body = (await screen.findAllByTestId('comment-body'))[0]!;
  expect(body.textContent).toBe(XSS);
  expect(container.querySelector('img, script')).toBeNull();
  expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  expect(screen.getAllByTestId('comment-body')[1]!.className).toContain('whitespace-pre-wrap');
});

it('offers Edit and Delete on the author\'s own comment only', async () => {
  render(<CommentsPanel recordType="customer_invoice" recordId="r1" />);
  await screen.findAllByTestId('comment-item');
  const [mine, theirs] = screen.getAllByTestId('comment-item');
  expect(mine!.textContent).toContain('Edit');
  expect(mine!.textContent).toContain('Delete');
  expect(theirs!.textContent).not.toContain('Edit');
  expect(theirs!.textContent).not.toContain('Delete');
});

it('a viewer reads the thread but has no composer and no Edit/Delete', async () => {
  role = 'viewer';
  render(<CommentsPanel recordType="customer_invoice" recordId="r1" />);
  await screen.findAllByTestId('comment-item');
  expect(screen.queryByLabelText('Add a comment')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});

it('posts the text with the mention picked from the list, as an id', async () => {
  render(<CommentsPanel recordType="customer_invoice" recordId="r1" />);
  const box = await screen.findByLabelText('Add a comment');
  fireEvent.change(box, { target: { value: 'please check' } });
  choose('Olive Owner');
  expect((box as HTMLTextAreaElement).value).toBe('please check @Olive Owner ');
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  await vi.waitFor(() => expect(writes).toEqual([{ method: 'POST',
    body: { recordType: 'customer_invoice', recordId: 'r1', body: 'please check @Olive Owner ', mentions: ['olive'] } }]));
});

it('a mention whose name was deleted from the text is not sent', async () => {
  render(<CommentsPanel recordType="customer_invoice" recordId="r1" />);
  const box = await screen.findByLabelText('Add a comment');
  choose('Olive Owner');
  fireEvent.change(box, { target: { value: 'never mind' } });
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  await vi.waitFor(() => expect((writes[0]!.body as { mentions: string[] }).mentions).toEqual([]));
});

it('a refused post shows the server message and keeps the text', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method ? new Response(JSON.stringify({ success: false, error: { message: 'You are commenting too fast.' } }), { status: 429 }) : ok(READ));
  render(<CommentsPanel recordType="customer_invoice" recordId="r1" />);
  const box = await screen.findByLabelText('Add a comment');
  fireEvent.change(box, { target: { value: 'keep me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
  expect((await screen.findByRole('alert')).textContent).toContain('commenting too fast');
  expect((box as HTMLTextAreaElement).value).toBe('keep me');
});

it('a failed read says so instead of showing "No comments yet"', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => new Response('{}', { status: 500 }));
  render(<CommentsPanel recordType="customer_invoice" recordId="r1" />);
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load the comments');
  expect(screen.queryByText('No comments yet.')).toBeNull();
});

it('the mention picker is the kit Select, not a native select', async () => {
  const { container } = render(<CommentsPanel recordType="customer_invoice" recordId="r1" />);
  await screen.findByLabelText('Add a comment');
  expect(screen.getByRole('combobox', { name: 'Mention a colleague' })).toBeTruthy();
  expect(container.querySelector('select')).toBeNull();
});

it('no colleague list (a read-only role, or nobody else): no picker at all', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => ok({ ...READ, mentionable: [] }));
  render(<CommentsPanel recordType="customer_invoice" recordId="r1" />);
  await screen.findByLabelText('Add a comment');
  expect(screen.queryByRole('combobox', { name: 'Mention a colleague' })).toBeNull();
});
