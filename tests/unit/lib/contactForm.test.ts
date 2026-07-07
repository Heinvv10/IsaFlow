import { describe, expect, it } from 'vitest';
import { validateContactSubmission, buildContactEmail } from '@/lib/contactForm';

describe('validateContactSubmission', () => {
  const valid = {
    name: '  Thandi Molefe ',
    email: '  Thandi@Example.CO.ZA ',
    company: ' Acme (Pty) Ltd ',
    message: 'We would like to book a demo for our practice.',
    website: '',
  };

  it('accepts a valid submission and normalises name/email/company', () => {
    const r = validateContactSubmission(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.name).toBe('Thandi Molefe');
      expect(r.data.email).toBe('thandi@example.co.za');
      expect(r.data.company).toBe('Acme (Pty) Ltd');
    }
  });

  it('allows a missing company (optional)', () => {
    const { company: _drop, ...rest } = valid;
    void _drop;
    expect(validateContactSubmission(rest).ok).toBe(true);
  });

  it('rejects a missing name', () => {
    expect(validateContactSubmission({ ...valid, name: '   ' }).ok).toBe(false);
  });

  it('rejects an invalid email', () => {
    expect(validateContactSubmission({ ...valid, email: 'not-an-email' }).ok).toBe(false);
  });

  it('rejects a too-short message', () => {
    expect(validateContactSubmission({ ...valid, message: 'hi' }).ok).toBe(false);
  });

  it('rejects a too-long message (>2000 chars)', () => {
    expect(validateContactSubmission({ ...valid, message: 'x'.repeat(2001) }).ok).toBe(false);
  });

  it('rejects a filled honeypot (website) as spam', () => {
    const r = validateContactSubmission({ ...valid, website: 'http://spam.example' });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-object body', () => {
    expect(validateContactSubmission(null).ok).toBe(false);
    expect(validateContactSubmission('nope').ok).toBe(false);
  });
});

describe('buildContactEmail', () => {
  const data = {
    name: 'Priya Naidoo',
    email: 'priya@firm.co.za',
    company: 'Naidoo & Associates',
    message: 'Interested in the bureau plan.',
  };

  it('puts the sender name in the subject', () => {
    expect(buildContactEmail(data).subject).toContain('Priya Naidoo');
  });

  it('includes the sender email and message in the body', () => {
    const { html } = buildContactEmail(data);
    expect(html).toContain('priya@firm.co.za');
    expect(html).toContain('Interested in the bureau plan.');
  });

  it('HTML-escapes user input to prevent injection in the email client', () => {
    const { html } = buildContactEmail({
      ...data,
      name: '<script>alert(1)</script>',
      message: 'a & b < c > d "quote"',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b &lt; c &gt; d');
  });
});
