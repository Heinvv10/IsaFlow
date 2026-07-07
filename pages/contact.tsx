import { useState, useEffect, type FormEvent } from 'react';
import Head from 'next/head';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { LandingNavbar } from '@/components/landing/LandingNavbar';
import { LandingFooter } from '@/components/landing/LandingPricingTestimonialsFooter';

type Status = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Public "Book a demo / contact us" page. Posts to /api/contact, which emails
 * the sales inbox. Unauthenticated; abuse is bounded server-side by rate-limit +
 * honeypot (the hidden `website` field below).
 */
export default function ContactPage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus('sending');
    setError('');
    const form = e.currentTarget;
    const data = new FormData(form);
    const payload = {
      name: String(data.get('name') ?? ''),
      email: String(data.get('email') ?? ''),
      company: String(data.get('company') ?? ''),
      message: String(data.get('message') ?? ''),
      website: String(data.get('website') ?? ''), // honeypot
    };

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success) {
        setStatus('sent');
        form.reset();
      } else {
        setStatus('error');
        setError(json?.error?.message ?? 'Something went wrong. Please email accounts@isaflow.co.za.');
      }
    } catch {
      setStatus('error');
      setError('Could not reach the server. Please email accounts@isaflow.co.za.');
    }
  }

  const inputClass =
    'w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/30';

  return (
    <>
      <Head>
        <title>Contact us — ISAFlow | Book a demo</title>
        <meta
          name="description"
          content="Book a demo or talk to the ISAFlow team about books, VAT, payroll and the month-end Close Agent for your business or practice."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className="min-h-screen bg-white text-gray-900">
        <LandingNavbar
          scrolled={scrolled}
          mobileMenuOpen={mobileMenuOpen}
          onToggleMobile={() => setMobileMenuOpen(!mobileMenuOpen)}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />

        <section className="relative bg-[#050a0f] text-white pt-32 pb-16 lg:pt-40 lg:pb-20 overflow-hidden">
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(20,184,166,0.18),transparent_70%)]"
          />
          <div className="relative max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <p className="text-sm font-semibold text-teal-400 tracking-widest uppercase mb-4">Contact</p>
            <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.05] mb-4">
              Book a demo
            </h1>
            <p className="text-lg text-white/70">
              See IsaFlow close a messy month live — books, VAT, payroll and the
              Close Agent. Tell us a little about you and we&apos;ll be in touch.
            </p>
          </div>
        </section>

        <section className="py-16 lg:py-20 bg-gray-50">
          <div className="max-w-xl mx-auto px-4 sm:px-6 lg:px-8">
            {status === 'sent' ? (
              <div className="rounded-2xl border border-teal-200 bg-teal-50 p-8 text-center">
                <CheckCircle2 className="w-10 h-10 text-teal-500 mx-auto mb-4" />
                <h2 className="text-xl font-bold text-gray-900 mb-2">Thanks — message sent</h2>
                <p className="text-gray-600">
                  We&apos;ve got your request and will be in touch shortly. You can
                  also reach us any time at{' '}
                  <a href="mailto:accounts@isaflow.co.za" className="font-semibold text-teal-600 hover:underline">
                    accounts@isaflow.co.za
                  </a>
                  .
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="rounded-2xl border border-gray-200 bg-white shadow-sm p-6 lg:p-8 space-y-5">
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1.5">Name</label>
                  <input id="name" name="name" type="text" required maxLength={100} autoComplete="name" className={inputClass} placeholder="Your name" />
                </div>
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1.5">Work email</label>
                  <input id="email" name="email" type="email" required maxLength={160} autoComplete="email" className={inputClass} placeholder="you@company.co.za" />
                </div>
                <div>
                  <label htmlFor="company" className="block text-sm font-medium text-gray-700 mb-1.5">
                    Company <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <input id="company" name="company" type="text" maxLength={120} autoComplete="organization" className={inputClass} placeholder="Your business or practice" />
                </div>
                <div>
                  <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-1.5">How can we help?</label>
                  <textarea id="message" name="message" required minLength={10} maxLength={2000} rows={5} className={inputClass} placeholder="Tell us about your business, your current tools, and what you'd like to see." />
                </div>

                {/* Honeypot — visually hidden, off the tab order; bots fill it, humans don't. */}
                <div className="absolute w-px h-px overflow-hidden -m-px" aria-hidden="true">
                  <label htmlFor="website">Leave this field empty</label>
                  <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
                </div>

                {status === 'error' && (
                  <p className="text-sm text-red-600" role="alert">{error}</p>
                )}

                <button
                  type="submit"
                  disabled={status === 'sending'}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gray-900 px-6 py-3.5 text-sm font-semibold text-white transition-all hover:bg-gray-800 disabled:opacity-60"
                >
                  {status === 'sending' ? 'Sending…' : (<>Send message <ArrowRight className="w-4 h-4" /></>)}
                </button>
                <p className="text-center text-xs text-gray-400">
                  Prefer email? <a href="mailto:accounts@isaflow.co.za" className="text-teal-600 hover:underline">accounts@isaflow.co.za</a>
                </p>
              </form>
            )}
          </div>
        </section>

        <LandingFooter />
      </div>
    </>
  );
}
