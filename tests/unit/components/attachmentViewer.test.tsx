/**
 * The attachment viewer shows a receipt in place instead of downloading it. Stored bank attachments are base64 data
 * URLs, which Chrome will not open as a top-level page and frames unreliably, so the viewer turns each into a blob:
 * URL (frame-src and img-src allow blob:, see config/securityHeaders.js) and frees it when it moves on.
 *
 * Only the inert types SAFE_HREF already trusts are previewed; anything else (a data:text/html row, an https link the
 * CSP will not frame) falls back to "Preview not available", so the viewer can never become a script sink.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentViewer } from '@/components/accounting/AttachmentViewer';
import { previewKind, dataUrlToBlob } from '@/components/accounting/attachmentPreview';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';
const HTML = 'data:text/html;base64,PHNjcmlwdD4=';
const FILES = [
  { id: 'a1', file_name: 'slip.png', file_url: PNG },
  { id: 'a2', file_name: 'invoice.pdf', file_url: PDF },
  { id: 'a3', file_name: 'evil.html', file_url: HTML },
];

let created: Blob[] = [];
let revoked: string[] = [];
beforeEach(() => {
  created = []; revoked = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { created.push(b as Blob); return `blob:test/${created.length}`; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => { revoked.push(u); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('previewKind', () => {
  it('previews only the inert image and PDF data URLs', () => {
    expect(previewKind(PNG)).toBe('image');
    expect(previewKind('data:image/jpeg;base64,/9j/')).toBe('image');
    expect(previewKind(PDF)).toBe('pdf');
    expect(previewKind(HTML)).toBe('none');
    expect(previewKind('data:image/svg+xml;base64,PHN2Zz4=')).toBe('none');
    expect(previewKind('https://files.example/slip.pdf')).toBe('none');
    expect(previewKind('javascript:alert(1)')).toBe('none');
  });

  it('decodes a data URL into a blob of its own type and bytes', async () => {
    const blob = dataUrlToBlob(PDF)!;
    expect(blob.type).toBe('application/pdf');
    expect(new TextDecoder().decode(await blob.arrayBuffer())).toBe('%PDF-1.4\n');
    expect(dataUrlToBlob('data:image/png;base64,***')).toBeNull();
  });
});

describe('AttachmentViewer', () => {
  it('shows an image in place from a blob: URL, never the data URL', () => {
    render(<AttachmentViewer attachments={FILES} startIndex={0} onClose={() => undefined} />);
    expect(screen.getByRole('dialog', { name: 'Attachment preview' }).getAttribute('aria-modal')).toBe('true');
    const img = screen.getByRole('img', { name: 'slip.png' });
    expect(img.getAttribute('src')).toBe('blob:test/1');
    expect(created[0]!.type).toBe('image/png');
    expect(screen.getByText('1 of 3')).toBeTruthy();
  });

  it('shows a PDF in a frame, steps with Next / Previous and the arrow keys, and frees each blob it leaves', () => {
    render(<AttachmentViewer attachments={FILES} startIndex={0} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next attachment' }));
    expect(screen.getByTitle('invoice.pdf').tagName).toBe('IFRAME');
    expect(screen.getByTitle('invoice.pdf').getAttribute('src')).toBe('blob:test/2');
    expect(revoked).toContain('blob:test/1');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(screen.getByRole('img', { name: 'slip.png' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous attachment' })).toBeDisabled();
  });

  it('refuses to render an unsafe type and offers no download for it', () => {
    render(<AttachmentViewer attachments={FILES} startIndex={2} onClose={() => undefined} />);
    expect(screen.getByText('Preview not available for this file')).toBeTruthy();
    expect(document.querySelector('iframe, img')).toBeNull();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(created).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Next attachment' })).toBeDisabled();
  });

  it('downloads the shown file from its blob, under its own name', () => {
    render(<AttachmentViewer attachments={FILES} startIndex={1} onClose={() => undefined} />);
    const link = screen.getByRole('link', { name: 'Download invoice.pdf' });
    expect(link.getAttribute('href')).toBe('blob:test/1');
    expect(link.getAttribute('download')).toBe('invoice.pdf');
  });

  it('closes on Escape and on the close button, and frees the blob on the way out', () => {
    const onClose = vi.fn();
    const { unmount } = render(<AttachmentViewer attachments={FILES} startIndex={0} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => { unmount(); });
    expect(revoked).toContain('blob:test/1');
  });

  it('moves focus to the dialog when a step disables the focused button, so the keys keep working', () => {
    const onClose = vi.fn();
    render(<AttachmentViewer attachments={FILES} startIndex={1} onClose={onClose} />);
    const next = screen.getByRole('button', { name: 'Next attachment' });
    next.focus();
    fireEvent.click(next);
    expect(next).toBeDisabled();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.getByTitle('invoice.pdf')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab inside the viewer and puts focus back on its opener when it closes', () => {
    const { rerender } = render(<><button>opener</button></>);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    rerender(<><button>opener</button><AttachmentViewer attachments={FILES} startIndex={0} onClose={() => undefined} /></>);
    const close = screen.getByRole('button', { name: 'Close preview' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
    rerender(<><button>opener</button></>);
    expect(document.activeElement).toBe(opener);
  });

  it('keeps its keys to itself, so Escape does not reach the modal or grid behind it', () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><AttachmentViewer attachments={FILES} startIndex={0} onClose={() => undefined} /></div>);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('AttachmentViewer placement', () => {
  it('renders into document.body, outside the layout column whose stacking context the top nav draws over', () => {
    const { container } = render(<main style={{ position: 'relative', zIndex: 0 }}>
      <AttachmentViewer attachments={FILES} startIndex={0} onClose={() => undefined} />
    </main>);
    const dialog = screen.getByRole('dialog', { name: 'Attachment preview' });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
  });
});
