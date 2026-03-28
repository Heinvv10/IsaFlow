/**
 * Fetch wrapper that automatically injects the active company ID header.
 * Use this instead of raw fetch() for all accounting API calls.
 */

const COMPANY_STORAGE_KEY = 'isaflow_active_company';

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers);

  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(COMPANY_STORAGE_KEY);
    if (stored) {
      try {
        const { id } = JSON.parse(stored);
        if (id) headers.set('X-Company-Id', id);
      } catch {
        // Invalid JSON — ignore
      }
    }
  }

  return fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });
}
