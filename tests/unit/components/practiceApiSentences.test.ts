/**
 * practiceApi: an empty-body 5xx must read as a plain sentence, never "Request to /api/... failed".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fetchActiveClients, fetchJobCategories } from '@/components/practice/practiceApi';

useApiJsonOverMock();
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('practiceApi failure sentences', () => {
  it('empty 500 on the clients list', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response('', { status: 500 }));
    await expect(fetchActiveClients()).rejects.toThrow('Could not load the clients - try again');
  });
  it('empty 500 on the job categories', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response('', { status: 500 }));
    await expect(fetchJobCategories()).rejects.toThrow('Could not load the job categories - try again');
  });
  it('a 400 keeps the server message', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: false, error: { code: 'X', message: 'D2 server says no' } }), { status: 400 }));
    await expect(fetchActiveClients()).rejects.toThrow('D2 server says no');
  });
});
