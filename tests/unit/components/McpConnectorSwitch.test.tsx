// The MCP connector switch (migration 1058): owner/admin can switch it, other roles see why not, a platform OFF is a
// lock, the consent note always shows, and a failed POST says so in a plain sentence.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { McpConnectorSwitch, MCP_SWITCH_COPY, type McpConnectorState } from '@/components/accounting/settings/McpConnectorSwitch';

afterEach(cleanup);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });

const OWNER_OFF: McpConnectorState = { enabled: false, lockedByPlatform: false, canToggle: true };

describe('McpConnectorSwitch', () => {
  it('owner: an enabled switch that POSTs { enabled: true } and takes the answer', async () => {
    const onChange = vi.fn();
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: { ...OWNER_OFF, enabled: true } }), { status: 200 }));
    render(<McpConnectorSwitch state={OWNER_OFF} onChange={onChange} />);
    const sw = screen.getByRole('switch');
    expect(sw).not.toBeDisabled();
    expect(screen.getByTestId('mcp-connector-state').textContent).toBe('Off');
    fireEvent.click(sw);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...OWNER_OFF, enabled: true }));
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]!;
    expect(url).toBe('/api/accounting/mcp-connector-setting');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ enabled: true });
  });

  it('viewer: disabled, with the reason, and never POSTs', () => {
    render(<McpConnectorSwitch state={{ enabled: true, lockedByPlatform: false, canToggle: false }} onChange={vi.fn()} />);
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText(MCP_SWITCH_COPY.notOwner)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch'));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('locked by a platform admin: disabled for the owner, with the IsaFlow sentence', () => {
    render(<McpConnectorSwitch state={{ enabled: false, lockedByPlatform: true, canToggle: true }} onChange={vi.fn()} />);
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByText('Switched off by IsaFlow. Contact IsaFlow support.')).toBeTruthy();
  });

  it('shows the consent note, and the switch-off effect when on', () => {
    render(<McpConnectorSwitch state={{ enabled: true, lockedByPlatform: false, canToggle: true }} onChange={vi.fn()} />);
    expect(screen.getByText('Each person still approves access in the sign-in window. Write permissions start unticked.')).toBeTruthy();
    expect(screen.getByText(/Connected assistants stop working straight away/)).toBeTruthy();
  });

  it('a failed POST shows a plain sentence and keeps the state', async () => {
    const onChange = vi.fn();
    vi.mocked(apiFetch).mockResolvedValue(new Response('', { status: 500 }));
    render(<McpConnectorSwitch state={OWNER_OFF} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByRole('alert')).toHaveTextContent(MCP_SWITCH_COPY.failed);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a 409 shows the server's sentence", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message: MCP_SWITCH_COPY.locked } }), { status: 409 }));
    render(<McpConnectorSwitch state={OWNER_OFF} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByRole('alert')).toHaveTextContent(MCP_SWITCH_COPY.locked);
  });
});
