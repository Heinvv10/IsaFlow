/**
 * Public terms of service. Reachable without login: middleware only gates
 * /accounting and /payroll.
 */
import Link from 'next/link';
import { LegalPage } from '@/components/legal/LegalPage';
import { LEGAL_ENTITY } from '@/config/legalEntity';

const mail = `mailto:${LEGAL_ENTITY.contactEmail}`;

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      description="The terms that apply to your use of IsaFlow, operated by Brightsphere Technologies (Pty) Ltd."
    >
      <h2>1. Who these Terms are between</h2>
      <p>
        These Terms are a contract between you (or the business you represent) and{' '}
        <strong>{LEGAL_ENTITY.name}</strong>, registration number{' '}
        {LEGAL_ENTITY.registrationNumber}, trading as IsaFlow (&quot;Brightsphere&quot;,
        &quot;we&quot;, &quot;us&quot;). By creating an account or using IsaFlow, you agree to
        these Terms. If you accept them on behalf of a business, you confirm you are authorised
        to bind it.
      </p>

      <h2>2. Supplier information</h2>
      <ul>
        <li>Full name: {LEGAL_ENTITY.name}</li>
        <li>Legal status: {LEGAL_ENTITY.legalStatus}</li>
        <li>Registration number: {LEGAL_ENTITY.registrationNumber}</li>
        <li>Registered and physical address for legal notices: {LEGAL_ENTITY.registeredAddress}</li>
        <li>Director: {LEGAL_ENTITY.director}</li>
        <li>
          Email: <a href={mail}>{LEGAL_ENTITY.contactEmail}</a>
        </li>
        <li>Website: {LEGAL_ENTITY.website}</li>
      </ul>
      <p>
        These details are provided under section 43 of the Electronic Communications and
        Transactions Act 25 of 2002.
      </p>

      <h2>3. The service</h2>
      <p>
        IsaFlow is online accounting software for South African businesses and practices,
        covering bookkeeping, invoicing, banking, VAT, payroll and reporting. Features available
        to you depend on your plan. We may improve and change features over time, but will not
        materially reduce the core service of a paid plan during a paid period without notice.
      </p>

      <h2>4. Your account</h2>
      <ul>
        <li>Keep your sign-in details secure and enable multi-factor authentication where offered.</li>
        <li>You are responsible for activity under your account and for the users you invite.</li>
        <li>Tell us promptly at {LEGAL_ENTITY.contactEmail} if you suspect unauthorised access.</li>
      </ul>

      <h2>5. Fees and billing</h2>
      <p>
        Fees are shown on our <Link href="/pricing">pricing page</Link> or in your order and
        include VAT unless stated otherwise. Subscriptions renew automatically for the same
        period until cancelled. We will give at least 30 days&apos; notice of a price change,
        which applies from your next billing period. Unpaid accounts may be restricted after
        notice; your records are not deleted because of late payment.
      </p>

      <h2>6. Your data</h2>
      <p>
        You own the records you put into IsaFlow. You give us the permission we need to host,
        process and back them up to provide the service. We handle personal information as
        described in our <Link href="/privacy">Privacy Policy</Link> and act as your operator
        for personal information in your records under the Protection of Personal Information
        Act 4 of 2013. You can export your records while your account is active.
      </p>

      <h2>7. Your responsibilities</h2>
      <p>
        IsaFlow is a tool. You remain responsible for the accuracy of your records, for
        reviewing what you submit, and for your filings and payments to SARS and other
        authorities. IsaFlow does not provide tax, legal or audit advice. Have a qualified
        professional review your position where needed.
      </p>

      <h2>8. AI features and assistant connections</h2>
      <p>
        AI features produce suggestions, such as categorisations, summaries and answers, which
        may be wrong. Review them before relying on them or posting them to your ledger. If you
        enable an AI assistant connection, it acts only within the permissions you grant, and
        you may revoke it at any time.
      </p>

      <h2>9. Acceptable use</h2>
      <p>You may not:</p>
      <ul>
        <li>use IsaFlow for unlawful purposes, including fraud, money laundering or tax evasion;</li>
        <li>access another company&apos;s data, or attempt to bypass security or usage limits;</li>
        <li>reverse engineer, resell or copy the service except as these Terms allow; or</li>
        <li>upload malicious code or content you have no right to use.</li>
      </ul>

      <h2>10. Availability and support</h2>
      <p>
        We aim to keep IsaFlow available and back up data regularly, but the service is not
        guaranteed to be uninterrupted or error-free. We will try to give notice of planned
        maintenance.
      </p>

      <h2>11. Intellectual property</h2>
      <p>
        We own IsaFlow, its software and its content. These Terms give you a non-exclusive,
        non-transferable right to use the service during your subscription.
      </p>

      <h2>12. Liability</h2>
      <p>
        To the extent the law permits, we are not liable for indirect or consequential loss,
        such as lost profit or penalties caused by inaccurate records you submit, and our total
        liability in any 12-month period is limited to the fees you paid us in that period.
        This does not limit liability for our gross negligence, wilful misconduct or fraud, or
        any rights you have under the Consumer Protection Act 68 of 2008 where it applies to you.
      </p>

      <h2>13. Cancellation and termination</h2>
      <p>
        You may cancel at any time in your settings or by emailing us; cancellation takes effect
        at the end of the current billing period. We may suspend or terminate an account for a
        material breach of these Terms that is not remedied within 14 days of notice, or
        immediately where the law requires or the breach threatens the security of the service.
        You can export your records before your account closes.
      </p>

      <h2>14. Changes to these Terms</h2>
      <p>
        We will notify account holders of material changes at least 30 days before they take
        effect. Continuing to use IsaFlow after that means you accept the updated Terms.
      </p>

      <h2>15. Governing law</h2>
      <p>
        These Terms are governed by the law of the Republic of South Africa. Before going to
        court, both parties will try to resolve a dispute in good faith for 30 days. Our
        address for service of legal notices is the address in clause 2.
      </p>
    </LegalPage>
  );
}
