import { useEffect, useState } from 'react';
import Script from 'next/script';

const HOST_TO_TRACKING: Record<string, string> = {
  'isaflow.co.za':       'isa_mkt_001',
  'www.isaflow.co.za':   'isa_mkt_001',
  'app.isaflow.co.za':   'isa_app_001',
  'admin.isaflow.co.za': 'isa_admin_001',
};

function resolveTrackingId(hostname: string): string | null {
  if (HOST_TO_TRACKING[hostname]) return HOST_TO_TRACKING[hostname] ?? null;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local')) {
    return 'isa_mkt_001';
  }
  return null;
}

export function TrackerScript({ userId }: { userId?: string | null }) {
  const [trackingId, setTrackingId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setTrackingId(resolveTrackingId(window.location.hostname));
  }, []);

  if (!trackingId) return null;

  return (
    <Script
      src="/isa-track.js"
      strategy="afterInteractive"
      data-t={trackingId}
      {...(userId ? { 'data-u': userId } : {})}
    />
  );
}
