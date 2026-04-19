// src/components/layout/ImpersonationBanner.tsx
// Orange bar shown when an admin is impersonating another user.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]!) : null;
}

export function ImpersonationBanner() {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setActive(readCookie('is_impersonating') === '1');
  }, [router.asPath]);

  const handleReturn = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/auth/end-impersonation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const json = await res.json() as { success: boolean; data?: { redirect: string }; error?: { message: string } };
      if (json.success && json.data?.redirect) {
        window.location.href = json.data.redirect;
      } else {
        alert(json.error?.message ?? 'Failed to end impersonation');
        setBusy(false);
      }
    } catch {
      alert('Network error. Please try again.');
      setBusy(false);
    }
  }, []);

  if (!active) return null;

  return (
    <div
      role="status"
      className="w-full bg-orange-500 text-white px-4 py-2 flex items-center justify-between text-sm font-medium shadow"
    >
      <span>Impersonating another user. Actions are audit-logged.</span>
      <button
        className="ml-4 px-3 py-1 rounded-md bg-white text-orange-700 font-semibold hover:bg-orange-50 disabled:opacity-50"
        onClick={handleReturn}
        disabled={busy}
      >
        {busy ? 'Returning\u2026' : 'Return to my session'}
      </button>
    </div>
  );
}
