/**
 * EmailTemplatesTab — per-document-type email subject + body templates.
 * Templates are stored as columns on the companies table.
 * Supported placeholder variables: {customer}, {number}, {amount}, {due_date}, {company}
 */

import { useState } from 'react';
import { Mail, ChevronDown, ChevronRight } from 'lucide-react';
import { Company, INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
}

const TEXTAREA_CLS =
  'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] ' +
  'text-[var(--ff-text-primary)] text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 ' +
  'outline-none resize-y min-h-[100px]';

const PLACEHOLDER_VARS = [
  { token: '{customer}', description: 'Customer / supplier name' },
  { token: '{number}', description: 'Document number (e.g. INV-0001)' },
  { token: '{amount}', description: 'Document total amount' },
  { token: '{due_date}', description: 'Payment due date' },
  { token: '{company}', description: 'Your company name' },
];

interface TemplateSection {
  label: string;
  subjectField: keyof Company;
  bodyField: keyof Company;
  defaultSubject: string;
}

const TEMPLATE_SECTIONS: TemplateSection[] = [
  {
    label: 'Customer Invoice',
    subjectField: 'invoiceEmailSubject',
    bodyField: 'invoiceEmailBody',
    defaultSubject: 'Invoice {number} from {company}',
  },
  {
    label: 'Quotation',
    subjectField: 'quoteEmailSubject',
    bodyField: 'quoteEmailBody',
    defaultSubject: 'Quote {number} from {company}',
  },
  {
    label: 'Statement',
    subjectField: 'statementEmailSubject',
    bodyField: 'statementEmailBody',
    defaultSubject: 'Statement from {company}',
  },
];

function TemplateBlock({
  section,
  company,
  onChange,
}: {
  section: TemplateSection;
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const subject = String(company[section.subjectField] ?? section.defaultSubject);
  const body = (company[section.bodyField] as string | null) ?? '';

  return (
    <div className="border border-[var(--ff-border-primary)] rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className="w-full flex items-center justify-between px-4 py-3 bg-[var(--ff-bg-secondary)] hover:bg-[var(--ff-bg-primary)] transition-colors text-left"
      >
        <span className="text-sm font-medium text-[var(--ff-text-primary)]">{section.label}</span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-[var(--ff-text-secondary)]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[var(--ff-text-secondary)]" />
        )}
      </button>

      {open && (
        <div className="p-4 space-y-4 border-t border-[var(--ff-border-primary)]">
          <div>
            <label className={LABEL_CLS}>Email Subject</label>
            <input
              type="text"
              className={INPUT_CLS}
              value={subject}
              onChange={e => onChange(section.subjectField, e.target.value)}
              placeholder={section.defaultSubject}
            />
          </div>
          <div>
            <label className={LABEL_CLS}>Email Body</label>
            <textarea
              className={TEXTAREA_CLS}
              rows={5}
              value={body}
              onChange={e => onChange(section.bodyField, e.target.value)}
              placeholder={`Dear {customer},\n\nPlease find attached ${section.label.toLowerCase()} {number}.\n\nKind regards,\n{company}`}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function EmailTemplatesTab({ company, onChange }: Props) {
  return (
    <>
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1 flex items-center gap-2">
          <Mail className="h-5 w-5" /> Email Templates
        </h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-3">
          Customise the subject line and body used when emailing documents to customers.
          Leave the body blank to use the system default.
        </p>

        {/* Placeholder variable reference */}
        <div className="mb-5 p-3 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)]">
          <p className="text-xs font-medium text-[var(--ff-text-secondary)] mb-2">Available placeholders</p>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {PLACEHOLDER_VARS.map(({ token, description }) => (
              <span key={token} className="text-xs text-[var(--ff-text-tertiary)]">
                <code className="text-teal-400 font-mono">{token}</code> — {description}
              </span>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          {TEMPLATE_SECTIONS.map(section => (
            <TemplateBlock
              key={section.subjectField}
              section={section}
              company={company}
              onChange={onChange}
            />
          ))}
        </div>
      </section>
    </>
  );
}
