/**
 * Public privacy policy. POPIA (Act 4 of 2013) is the governing framework.
 * Reachable without login: middleware only gates /accounting and /payroll.
 */
import { LegalPage } from '@/components/legal/LegalPage';
import { LEGAL_ENTITY } from '@/config/legalEntity';

const mail = `mailto:${LEGAL_ENTITY.contactEmail}`;

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      description="How Brightsphere Technologies, trading as IsaFlow, collects, uses and protects personal information under POPIA."
    >
      <p>
        This policy explains how IsaFlow handles personal information, in line with the
        Protection of Personal Information Act 4 of 2013 (POPIA).
      </p>

      <h2>1. Who we are</h2>
      <p>
        IsaFlow is operated by <strong>{LEGAL_ENTITY.name}</strong>, registration number{' '}
        {LEGAL_ENTITY.registrationNumber}, with its registered office at{' '}
        {LEGAL_ENTITY.registeredAddress} (&quot;Brightsphere&quot;, &quot;we&quot;, &quot;us&quot;).
      </p>
      <p>
        Our Information Officer is {LEGAL_ENTITY.informationOfficer}. Contact:{' '}
        <a href={mail}>{LEGAL_ENTITY.contactEmail}</a>.
      </p>

      <h2>2. Our two roles</h2>
      <ul>
        <li>
          <strong>Responsible party</strong> for information about our own users and
          prospects: account holders, people who contact us, and billing contacts.
        </li>
        <li>
          <strong>Operator</strong> for the accounting records you put into IsaFlow, which
          may include information about your customers, suppliers and employees. You remain
          the responsible party for that information and decide why it is processed. We
          process it only on your instructions and to provide the service (POPIA s21).
        </li>
      </ul>

      <h2>3. What we collect</h2>
      <ul>
        <li>Account details: name, email address, phone number, company name and role.</li>
        <li>Company details: registration, VAT and tax reference numbers and addresses.</li>
        <li>
          Accounting records you capture or import: transactions, invoices, bank statements,
          supplier and customer details, and payroll information.
        </li>
        <li>Documents you send for capture, including by email or WhatsApp.</li>
        <li>Billing information. Card details are handled by our payment providers, not stored by us.</li>
        <li>Security and usage data: sign-in events, IP address, device and audit logs.</li>
      </ul>

      <h2>4. Why we use it</h2>
      <ul>
        <li>To provide, secure and support the service you signed up for (POPIA s11(1)(b)).</li>
        <li>To bill you and keep financial records we are legally required to keep (s11(1)(c)).</li>
        <li>To detect fraud, abuse and security incidents (s11(1)(f)).</li>
        <li>
          To send service and product updates. You can opt out of marketing at any time, and
          we will not send unsolicited electronic marketing without consent (s69).
        </li>
      </ul>
      <p>We do not sell personal information.</p>

      <h2>5. AI features</h2>
      <p>
        Some optional features, such as transaction categorisation, report narratives and
        natural-language queries, send the relevant records to an AI model provider to
        generate a result, or process it on our own self-hosted model. Outputs are suggestions
        for you to review. Under its commercial terms, our AI model provider does not use these
        inputs to train its models.
      </p>

      <h2>6. AI assistant connections</h2>
      <p>
        If your company enables an AI assistant connection, you choose the permissions it
        receives when you authorise it. You can revoke the connection at any time in your
        settings. Connections are switched off by default.
      </p>

      <h2>7. Who we share information with</h2>
      <p>We use service providers who process information on our behalf under written terms:</p>
      <ul>
        <li>Anthropic: AI model provider for optional AI features (United States).</li>
        <li>Paystack and Stitch: subscription and payment processing.</li>
        <li>Twilio: WhatsApp document capture.</li>
        <li>Postmark: inbound email document capture.</li>
        <li>Email delivery providers: account and transactional emails.</li>
        <li>Signum: electronic signing of annual financial statements, when you use it.</li>
      </ul>
      <p>
        We may also disclose information where the law requires it, for example to SARS or
        another regulator acting within its powers.
      </p>

      <h2>8. Where your information is kept</h2>
      <p>
        Our application and database servers are hosted in South Africa. Where a service
        provider processes information outside South Africa, we transfer it only where POPIA
        s72 allows, such as where the recipient is bound by protections substantially similar
        to POPIA.
      </p>

      <h2>9. Security</h2>
      <p>
        We take reasonable technical and organisational measures to protect personal
        information (POPIA s19). These include encryption in transit, access controls that
        keep each company&apos;s data separate, multi-factor authentication, audit logging and
        error monitoring on our own infrastructure. If we have reasonable grounds to believe
        your personal information has been compromised, we will notify you and the
        Information Regulator as required by POPIA s22.
      </p>

      <h2>10. How long we keep it</h2>
      <p>
        We keep account and accounting records while your subscription is active. After you
        close your account, you can export your records first. We then retain records only as
        long as the law requires or permits, including the retention periods in the Companies
        Act 71 of 2008 and the Tax Administration Act 28 of 2011, and then delete or
        de-identify them (POPIA s14).
      </p>

      <h2>11. Your rights</h2>
      <p>Under POPIA you may:</p>
      <ul>
        <li>ask whether we hold your personal information and request a copy (s23);</li>
        <li>ask us to correct or delete it (s24);</li>
        <li>object to processing, including for direct marketing (s11(3));</li>
        <li>withdraw consent where we rely on consent.</li>
      </ul>
      <p>
        For records you hold in IsaFlow about your own customers or staff, we will pass requests
        to you as the responsible party. Send requests to{' '}
        <a href={mail}>{LEGAL_ENTITY.contactEmail}</a>.
      </p>

      <h2>12. Complaints</h2>
      <p>
        Please contact us first so we can try to resolve your concern. You may also lodge a
        complaint with the Information Regulator (South Africa) at{' '}
        <a href="https://inforegulator.org.za" rel="noopener noreferrer" target="_blank">
          inforegulator.org.za
        </a>{' '}
        (POPIA s74).
      </p>

      <h2>13. Changes</h2>
      <p>
        We will update the date above when we change this policy, and tell account holders
        about material changes before they take effect.
      </p>
    </LegalPage>
  );
}
