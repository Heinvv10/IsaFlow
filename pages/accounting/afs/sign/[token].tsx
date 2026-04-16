// pages/accounting/afs/sign/[token].tsx
// Signing page — embeds Signum iframe. No staff/portal auth required.
// The signing token IS the auth. Signum validates it internally.

import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import type { GetServerSidePropsContext } from 'next';

interface PageProps {
  token: string;
  callbackBaseUrl: string;
}

export function getServerSideProps(context: GetServerSidePropsContext) {
  const token = (context.params as Record<string, string>).token ?? '';
  const callbackBaseUrl = process.env.SIGNUM_CALLBACK_BASE_URL ?? '';
  return { props: { token, callbackBaseUrl } };
}

export default function SigningPage({ token, callbackBaseUrl }: PageProps) {
  const [signingComplete, setSigningComplete] = useState(false);
  const [signingDeclined, setSigningDeclined] = useState(false);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // Only accept messages from the Signum iframe origin
      let signumOrigin: string;
      try {
        signumOrigin = new URL(callbackBaseUrl).origin;
      } catch {
        return;
      }
      if (event.origin !== signumOrigin) return;

      if (event.data?.type === 'signum:signed') {
        setSigningComplete(true);
      } else if (event.data?.type === 'signum:declined') {
        setSigningDeclined(true);
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [callbackBaseUrl]);

  const iframeSrc = callbackBaseUrl ? `${callbackBaseUrl}/${token}?embed=true` : null;

  return (
    <>
      <Head>
        <title>Sign Document — ISaFlow</title>
        <meta name="robots" content="noindex" />
      </Head>

      {/* Header — branding only, no nav */}
      <header style={styles.header}>
        <span style={styles.logoText}>ISaFlow</span>
        <span style={styles.headerLabel}>Document Signing</span>
      </header>

      <div style={styles.body}>
        {signingComplete ? (
          <div style={styles.completionCard}>
            <div style={styles.checkmark}>✓</div>
            <h1 style={styles.completionTitle}>Thank you — your signature has been recorded.</h1>
            <p style={styles.completionText}>
              You will receive a copy of the signed document by email once all signatures have been
              collected.
            </p>
            <a href="/accounting/afs/portal/dashboard" style={styles.portalLink}>
              Return to Portal
            </a>
          </div>
        ) : signingDeclined ? (
          <div style={styles.completionCard}>
            <div style={{ ...styles.checkmark, background: '#fef2f2', color: '#dc2626' }}>✕</div>
            <h1 style={styles.completionTitle}>Signing declined.</h1>
            <p style={styles.completionText}>
              The document has been marked as declined. Your accountant has been notified.
            </p>
            <a href="/accounting/afs/portal/dashboard" style={styles.portalLink}>
              Return to Portal
            </a>
          </div>
        ) : iframeSrc ? (
          <iframe
            src={iframeSrc}
            title="Document Signing"
            style={styles.iframe}
            allow="camera; microphone"
          />
        ) : (
          <div style={styles.completionCard}>
            <p style={styles.completionText}>Signing not configured. Please contact your accountant.</p>
          </div>
        )}
      </div>
    </>
  );
}

const HEADER_HEIGHT = 64;

const styles: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    padding: '0 2rem',
    height: `${HEADER_HEIGHT}px`,
    background: '#0f172a',
    color: '#fff',
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  logoText: {
    fontWeight: 700,
    fontSize: '1.125rem',
    color: '#38bdf8',
  },
  headerLabel: {
    color: '#64748b',
    fontSize: '0.875rem',
  },
  body: {
    marginTop: `${HEADER_HEIGHT}px`,
    height: `calc(100vh - ${HEADER_HEIGHT}px)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f8fafc',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 'none',
    display: 'block',
  },
  completionCard: {
    textAlign: 'center',
    maxWidth: '480px',
    padding: '2.5rem',
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: '1rem',
    boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
  },
  checkmark: {
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    background: '#f0fdf4',
    color: '#16a34a',
    fontSize: '1.75rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 1.25rem',
  },
  completionTitle: {
    fontSize: '1.25rem',
    fontWeight: 700,
    color: '#0f172a',
    margin: '0 0 0.75rem',
  },
  completionText: {
    color: '#475569',
    lineHeight: 1.6,
    margin: '0 0 1.5rem',
    fontSize: '0.9375rem',
  },
  portalLink: {
    display: 'inline-block',
    background: '#0ea5e9',
    color: '#fff',
    textDecoration: 'none',
    padding: '0.625rem 1.5rem',
    borderRadius: '0.5rem',
    fontWeight: 600,
    fontSize: '0.9375rem',
  },
};
