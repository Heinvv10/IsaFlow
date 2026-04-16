// pages/accounting/afs/portal/dashboard.tsx
// Client portal dashboard — requires portal session.
// Uses getServerSideProps to gate access server-side.

import React from 'react';
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSidePropsContext, InferGetServerSidePropsType } from 'next';
import { verifyPortalToken } from '@/lib/auth/portalJwt';
import type { PortalSession } from '@/modules/accounting/services/afs/afsTypes';

interface AfsDocument {
  id: string;
  fiscal_year: number | null;
  period: string | null;
  document_type: string;
  status: string;
  created_at: string;
}

interface PageProps {
  session: PortalSession;
  documents: AfsDocument[];
}

export async function getServerSideProps(context: GetServerSidePropsContext) {
  const cookie = context.req.cookies['portal_session'];
  if (!cookie) {
    return { redirect: { destination: '/accounting/afs/portal/login', permanent: false } };
  }

  const session = await verifyPortalToken(cookie);
  if (!session) {
    return { redirect: { destination: '/accounting/afs/portal/login?error=expired', permanent: false } };
  }

  // Fetch documents server-side to avoid FOUC
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/accounting/portal/documents`, {
      headers: { Cookie: `portal_session=${cookie}` },
    });
    const json = (await res.json()) as { data?: { documents: AfsDocument[] } };
    const documents: AfsDocument[] = json.data?.documents ?? [];
    return { props: { session, documents } };
  } catch {
    return { props: { session, documents: [] } };
  }
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  partner_review: 'Under Review',
  signed_off: 'Signed Off',
  filed: 'Filed',
};

const STATUS_COLORS: Record<string, string> = {
  draft: '#94a3b8',
  partner_review: '#f59e0b',
  signed_off: '#10b981',
  filed: '#6366f1',
};

export default function PortalDashboardPage({
  session,
  documents,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const afsDocs = documents.filter((d) => d.document_type === 'afs');
  const managementPacks = documents
    .filter((d) => d.document_type === 'management_pack')
    .slice(0, 6);

  return (
    <>
      <Head>
        <title>My Documents — ISaFlow Portal</title>
        <meta name="robots" content="noindex" />
      </Head>

      <div style={styles.page}>
        {/* Header */}
        <header style={styles.header}>
          <span style={styles.logoText}>ISaFlow Portal</span>
          <div style={styles.headerRight}>
            <span style={styles.roleLabel}>{session.role.replace(/_/g, ' ')}</span>
            <form action="/api/accounting/portal/auth/logout" method="post">
              <button type="submit" style={styles.logoutBtn}>
                Sign out
              </button>
            </form>
          </div>
        </header>

        <main style={styles.main}>
          {/* Latest AFS */}
          <section style={styles.section}>
            <h2 style={styles.sectionTitle}>Annual Financial Statements</h2>
            {afsDocs.length === 0 ? (
              <p style={styles.empty}>No financial statements available yet.</p>
            ) : (
              <div style={styles.docGrid}>
                {afsDocs.map((doc) => (
                  <Link
                    key={doc.id}
                    href={`/accounting/afs/portal/documents/${doc.id}`}
                    style={styles.docCard}
                  >
                    <div style={styles.docYear}>{doc.fiscal_year ?? '—'}</div>
                    <div style={styles.docPeriod}>{doc.period ?? 'Annual'}</div>
                    <span
                      style={{
                        ...styles.statusBadge,
                        background: `${STATUS_COLORS[doc.status] ?? '#94a3b8'}22`,
                        color: STATUS_COLORS[doc.status] ?? '#94a3b8',
                        border: `1px solid ${STATUS_COLORS[doc.status] ?? '#94a3b8'}44`,
                      }}
                    >
                      {STATUS_LABELS[doc.status] ?? doc.status}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* Recent Management Packs */}
          {managementPacks.length > 0 && (
            <section style={styles.section}>
              <h2 style={styles.sectionTitle}>Recent Management Packs</h2>
              <div style={styles.docGrid}>
                {managementPacks.map((doc) => (
                  <Link
                    key={doc.id}
                    href={`/accounting/afs/portal/documents/${doc.id}`}
                    style={styles.docCard}
                  >
                    <div style={styles.docYear}>{doc.period ?? '—'}</div>
                    <span
                      style={{
                        ...styles.statusBadge,
                        background: `${STATUS_COLORS[doc.status] ?? '#94a3b8'}22`,
                        color: STATUS_COLORS[doc.status] ?? '#94a3b8',
                        border: `1px solid ${STATUS_COLORS[doc.status] ?? '#94a3b8'}44`,
                      }}
                    >
                      {STATUS_LABELS[doc.status] ?? doc.status}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </main>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#f8fafc',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '1rem 2rem',
    background: '#0f172a',
    color: '#fff',
  },
  logoText: {
    fontWeight: 700,
    fontSize: '1.125rem',
    color: '#38bdf8',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  roleLabel: {
    background: '#1e293b',
    color: '#94a3b8',
    padding: '0.25rem 0.75rem',
    borderRadius: '999px',
    fontSize: '0.75rem',
    textTransform: 'capitalize',
  },
  logoutBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    color: '#94a3b8',
    padding: '0.375rem 0.875rem',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    cursor: 'pointer',
  },
  main: {
    maxWidth: '900px',
    margin: '0 auto',
    padding: '2rem 1.5rem',
  },
  section: {
    marginBottom: '2.5rem',
  },
  sectionTitle: {
    fontSize: '1.125rem',
    fontWeight: 700,
    color: '#0f172a',
    marginBottom: '1rem',
  },
  empty: {
    color: '#94a3b8',
    fontSize: '0.9rem',
  },
  docGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '1rem',
  },
  docCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    padding: '1.25rem',
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: '0.75rem',
    textDecoration: 'none',
    color: 'inherit',
    transition: 'box-shadow 0.15s',
  },
  docYear: {
    fontSize: '1.5rem',
    fontWeight: 700,
    color: '#0f172a',
  },
  docPeriod: {
    fontSize: '0.8125rem',
    color: '#64748b',
  },
  statusBadge: {
    display: 'inline-block',
    padding: '0.25rem 0.625rem',
    borderRadius: '999px',
    fontSize: '0.75rem',
    fontWeight: 500,
    alignSelf: 'flex-start',
    marginTop: '0.25rem',
  },
};
