// pages/accounting/afs/portal/documents/[documentId].tsx
// Document viewer for portal contacts. Shows sections with annotation UI for directors/CFOs.
// SECURITY: section.content is HTML from ISaFlow's own renderer (not user input).

import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSidePropsContext, InferGetServerSidePropsType } from 'next';
import { verifyPortalToken } from '@/lib/auth/portalJwt';
import { PORTAL_ACCESS_RULES } from '@/modules/accounting/services/afs/afsTypes';

interface NoteContentBlock {
  type: string;
  text?: string;
  items?: string[];
  headers?: string[];
  rows?: string[][];
}

interface NoteContent {
  blocks: NoteContentBlock[];
}

interface AfsSection {
  id: string;
  section_type: string;
  sort_order: number;
  status: string;
  content: NoteContent | null;
  ai_narrative: string | null;
}

interface AfsDocument {
  id: string;
  fiscal_year: number | null;
  period: string | null;
  document_type: string;
  status: string;
  signing_requested_at: string | null;
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
  const documentId = context.params?.documentId as string;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${baseUrl}/api/accounting/portal/documents/${documentId}`, {
      headers: { Cookie: `portal_session=${cookie}` },
    });
    if (!res.ok) {
      return { redirect: { destination: '/accounting/afs/portal/dashboard', permanent: false } };
    }
    const json = (await res.json()) as { data?: { document: AfsDocument; sections: AfsSection[] } };
    return {
      props: {
        document: json.data!.document,
        sections: json.data!.sections,
        canAnnotate: PORTAL_ACCESS_RULES[session.role].canAnnotate,
      },
    };
  } catch {
    return { redirect: { destination: '/accounting/afs/portal/dashboard', permanent: false } };
  }
}

export default function PortalDocumentPage({
  document: doc,
  sections,
  canAnnotate,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const [annotating, setAnnotating] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<string[]>([]);

  const isLocked = doc.status === 'signed_off' || doc.status === 'filed';
  const typeLabel = doc.document_type === 'afs' ? 'Annual Financial Statements' : 'Management Pack';

  async function submitComment(sectionId: string) {
    if (!commentText.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/accounting/portal/documents/${doc.id}/annotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionId, body: commentText.trim() }),
      });
      if (res.ok) {
        setSubmitted((p) => [...p, sectionId]);
        setAnnotating(null);
        setCommentText('');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Head>
        <title>{typeLabel}{doc.fiscal_year ? ` — ${doc.fiscal_year}` : ''} — ISaFlow Portal</title>
        <meta name="robots" content="noindex" />
      </Head>
      <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: 'system-ui,sans-serif' }}>
        <header style={{ display:'flex', alignItems:'center', gap:'1.5rem', padding:'0.875rem 2rem', background:'#0f172a', position:'sticky', top:0, zIndex:10 }}>
          <Link href="/accounting/afs/portal/dashboard" style={{ color:'#94a3b8', textDecoration:'none', fontSize:'0.875rem' }}>← Back</Link>
          <span style={{ fontWeight:600, color:'#f1f5f9', flex:1, fontSize:'0.9375rem' }}>{typeLabel}{doc.fiscal_year ? ` — ${doc.fiscal_year}` : ''}</span>
          <span style={{ background:'#1e293b', color:'#94a3b8', padding:'0.2rem 0.6rem', borderRadius:'999px', fontSize:'0.75rem' }}>{doc.status.replace(/_/g,' ')}</span>
          <form action="/api/accounting/portal/auth/logout" method="post">
            <button style={{ background:'transparent', border:'1px solid #334155', color:'#94a3b8', padding:'0.3rem 0.75rem', borderRadius:'0.375rem', fontSize:'0.8125rem', cursor:'pointer' }}>Sign out</button>
          </form>
        </header>
        <div style={{ display:'flex', maxWidth:'1200px', margin:'0 auto', padding:'2rem 1.5rem', gap:'2rem' }}>
          <aside style={{ width:'200px', flexShrink:0, position:'sticky', top:'60px', alignSelf:'flex-start' }}>
            <p style={{ fontSize:'0.7rem', fontWeight:600, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'0.5rem' }}>Sections</p>
            {sections.map((s) => (
              <a key={s.id} href={`#s-${s.id}`} style={{ display:'block', padding:'0.3rem 0.4rem', fontSize:'0.8rem', color:'#475569', textDecoration:'none', textTransform:'capitalize', marginBottom:'0.1rem' }}>
                {s.section_type.replace(/_/g,' ')}
              </a>
            ))}
          </aside>
          <main style={{ flex:1, minWidth:0 }}>
            {sections.map((s) => (
              <section key={s.id} id={`s-${s.id}`} style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:'0.75rem', padding:'1.75rem', marginBottom:'1.5rem' }}>
                <h2 style={{ fontSize:'1rem', fontWeight:700, color:'#0f172a', textTransform:'capitalize', marginBottom:'1rem' }}>{s.section_type.replace(/_/g,' ')}</h2>
                {s.content && Array.isArray(s.content.blocks) ? (
                  <div style={{ color: '#334155', lineHeight: 1.7 }}>
                    {s.content.blocks.map((block, idx) => {
                      if ((block.type === 'paragraph' || block.type === 'heading') && block.text) {
                        return block.type === 'heading'
                          ? <h3 key={idx} style={{ fontSize: '0.9375rem', fontWeight: 700, margin: '0.75rem 0 0.25rem' }}>{block.text}</h3>
                          : <p key={idx} style={{ margin: '0 0 0.5rem' }}>{block.text}</p>;
                      }
                      if (block.type === 'list' && Array.isArray(block.items)) {
                        return (
                          <ul key={idx} style={{ paddingLeft: '1.5rem', margin: '0 0 0.5rem' }}>
                            {block.items.map((item, i) => <li key={i}>{item}</li>)}
                          </ul>
                        );
                      }
                      // TODO: render 'table' blocks (headers + rows) in a future enhancement
                      return null;
                    })}
                  </div>
                ) : s.ai_narrative ? (
                  <p style={{ color:'#334155', lineHeight:1.7, margin:0 }}>{s.ai_narrative}</p>
                ) : null}
                {canAnnotate && !isLocked && (
                  <div style={{ marginTop:'1rem', paddingTop:'1rem', borderTop:'1px dashed #e2e8f0' }}>
                    {submitted.includes(s.id) ? (
                      <p style={{ color:'#10b981', fontSize:'0.875rem', margin:0 }}>Comment submitted.</p>
                    ) : annotating === s.id ? (
                      <div style={{ display:'flex', flexDirection:'column', gap:'0.75rem' }}>
                        <textarea value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Add a comment…" rows={3} style={{ width:'100%', padding:'0.625rem', border:'1.5px solid #d1d5db', borderRadius:'0.5rem', fontSize:'0.875rem', fontFamily:'inherit', boxSizing:'border-box', resize:'vertical' }} autoFocus />
                        <div style={{ display:'flex', gap:'0.5rem' }}>
                          <button onClick={() => submitComment(s.id)} disabled={submitting || !commentText.trim()} style={{ background:'#0ea5e9', color:'#fff', border:'none', borderRadius:'0.375rem', padding:'0.5rem 1rem', fontSize:'0.875rem', fontWeight:500, cursor:'pointer' }}>{submitting ? 'Saving…' : 'Submit'}</button>
                          <button onClick={() => { setAnnotating(null); setCommentText(''); }} style={{ background:'transparent', color:'#64748b', border:'1px solid #d1d5db', borderRadius:'0.375rem', padding:'0.5rem 1rem', fontSize:'0.875rem', cursor:'pointer' }}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setAnnotating(s.id)} style={{ background:'transparent', color:'#0ea5e9', border:'1px dashed #bae6fd', borderRadius:'0.375rem', padding:'0.375rem 0.75rem', fontSize:'0.8125rem', cursor:'pointer' }}>+ Add comment</button>
                    )}
                  </div>
                )}
              </section>
            ))}
          </main>
        </div>
      </div>
    </>
  );
}
