// pages/accounting/afs/portal/login.tsx
// Public portal login page — sends magic link email.
// No staff nav — standalone portal branding.

import React, { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';

type FormState = 'idle' | 'loading' | 'sent' | 'error';

const ERROR_MESSAGES: Record<string, string> = {
  expired: 'Your sign-in link has expired. Please request a new one.',
  missing_token: 'Invalid sign-in link. Please request a new one.',
};

export default function PortalLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<FormState>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const errorParam = router.query.error as string | undefined;
  const queryError = errorParam ? (ERROR_MESSAGES[errorParam] ?? 'An error occurred.') : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !email.includes('@')) {
      setErrorMessage('Please enter a valid email address.');
      setState('error');
      return;
    }

    setState('loading');
    setErrorMessage('');

    try {
      const res = await fetch('/api/accounting/portal/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      if (res.ok) {
        setState('sent');
      } else {
        setState('error');
        setErrorMessage('Something went wrong. Please try again.');
      }
    } catch {
      setState('error');
      setErrorMessage('Something went wrong. Please try again.');
    }
  }

  return (
    <>
      <Head>
        <title>Client Portal — ISaFlow</title>
        <meta name="robots" content="noindex" />
      </Head>

      <div style={styles.page}>
        <div style={styles.card}>
          {/* Header */}
          <div style={styles.header}>
            <div style={styles.logo}>
              <span style={styles.logoText}>ISaFlow</span>
            </div>
            <p style={styles.tagline}>Client Portal</p>
          </div>

          {/* Query error (from expired link, etc.) */}
          {queryError && (
            <div style={styles.alertWarning}>
              <span>{queryError}</span>
            </div>
          )}

          {state === 'sent' ? (
            <div style={styles.successBox}>
              <h2 style={styles.successTitle}>Check your email</h2>
              <p style={styles.successText}>
                We&apos;ve sent a sign-in link to <strong>{email}</strong>. The link expires in 30
                minutes.
              </p>
              <p style={styles.successHint}>
                If you don&apos;t see it, check your spam folder.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={styles.form}>
              <h1 style={styles.title}>Sign in to your portal</h1>
              <p style={styles.subtitle}>
                Enter your email address and we&apos;ll send you a sign-in link.
              </p>

              {state === 'error' && errorMessage && (
                <div style={styles.alertError}>
                  <span>{errorMessage}</span>
                </div>
              )}

              <div style={styles.fieldGroup}>
                <label htmlFor="email" style={styles.label}>
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  disabled={state === 'loading'}
                  style={styles.input}
                  autoComplete="email"
                  autoFocus
                />
              </div>

              <button type="submit" disabled={state === 'loading'} style={styles.button}>
                {state === 'loading' ? 'Sending…' : 'Send sign-in link'}
              </button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}

// ── Inline styles (no tailwind dependency for portal) ───────────────────────
const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
    padding: '1rem',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    background: '#fff',
    borderRadius: '1rem',
    padding: '2.5rem',
    width: '100%',
    maxWidth: '420px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  },
  header: {
    textAlign: 'center',
    marginBottom: '2rem',
  },
  logo: {
    display: 'inline-block',
    background: '#0ea5e9',
    borderRadius: '0.5rem',
    padding: '0.4rem 0.9rem',
    marginBottom: '0.5rem',
  },
  logoText: {
    color: '#fff',
    fontWeight: 700,
    fontSize: '1.25rem',
    letterSpacing: '-0.02em',
  },
  tagline: {
    color: '#64748b',
    fontSize: '0.875rem',
    margin: 0,
  },
  title: {
    fontSize: '1.25rem',
    fontWeight: 700,
    color: '#0f172a',
    margin: '0 0 0.5rem',
  },
  subtitle: {
    color: '#64748b',
    fontSize: '0.875rem',
    margin: '0 0 1.5rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  label: {
    fontSize: '0.875rem',
    fontWeight: 500,
    color: '#374151',
  },
  input: {
    padding: '0.625rem 0.875rem',
    border: '1.5px solid #d1d5db',
    borderRadius: '0.5rem',
    fontSize: '1rem',
    color: '#0f172a',
    outline: 'none',
    transition: 'border-color 0.15s',
    width: '100%',
    boxSizing: 'border-box',
  },
  button: {
    background: '#0ea5e9',
    color: '#fff',
    border: 'none',
    borderRadius: '0.5rem',
    padding: '0.75rem',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.15s',
    marginTop: '0.25rem',
  },
  alertWarning: {
    background: '#fffbeb',
    border: '1px solid #fcd34d',
    borderRadius: '0.5rem',
    padding: '0.75rem 1rem',
    color: '#92400e',
    fontSize: '0.875rem',
    marginBottom: '1rem',
  },
  alertError: {
    background: '#fef2f2',
    border: '1px solid #fca5a5',
    borderRadius: '0.5rem',
    padding: '0.75rem 1rem',
    color: '#991b1b',
    fontSize: '0.875rem',
  },
  successBox: {
    textAlign: 'center',
    padding: '1rem 0',
  },
  successTitle: {
    fontSize: '1.25rem',
    fontWeight: 700,
    color: '#0f172a',
    margin: '0 0 0.75rem',
  },
  successText: {
    color: '#334155',
    fontSize: '0.9375rem',
    lineHeight: 1.6,
    margin: '0 0 0.75rem',
  },
  successHint: {
    color: '#94a3b8',
    fontSize: '0.8125rem',
    margin: 0,
  },
};
