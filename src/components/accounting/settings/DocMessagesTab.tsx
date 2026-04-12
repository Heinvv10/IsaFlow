/**
 * DocMessagesTab — default footer messages per document type.
 * Messages are stored in the company_messages table via the messages Record<string,string>.
 * Keys match what DocumentsTab already uses (msg_customer_invoice, msg_supplier_po, etc.)
 * but we surface the four most commonly needed in a clean dedicated tab.
 */

import { MessageSquare } from 'lucide-react';
import { SECTION_CLS, LABEL_CLS } from './settingsTypes';

interface Props {
  messages: Record<string, string>;
  onMessageChange: (key: string, value: string) => void;
}

const TEXTAREA_CLS =
  'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] ' +
  'text-[var(--ff-text-primary)] text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 ' +
  'outline-none resize-y min-h-[80px]';

interface MessageField {
  key: string;
  label: string;
  placeholder: string;
}

const MESSAGE_FIELDS: MessageField[] = [
  {
    key: 'msg_customer_invoice',
    label: 'Customer Invoice',
    placeholder: 'e.g. Thank you for your business. Payment is due within 30 days.',
  },
  {
    key: 'msg_customer_quote',
    label: 'Quotation',
    placeholder: 'e.g. This quotation is valid for 30 days from the date of issue.',
  },
  {
    key: 'msg_statement',
    label: 'Statement',
    placeholder: 'e.g. Please contact us if you have any queries regarding this statement.',
  },
  {
    key: 'msg_supplier_po',
    label: 'Purchase Order',
    placeholder: 'e.g. Please confirm receipt of this purchase order within 24 hours.',
  },
];

export function DocMessagesTab({ messages, onMessageChange }: Props) {
  return (
    <section className={SECTION_CLS}>
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1 flex items-center gap-2">
        <MessageSquare className="h-5 w-5" /> Default Document Messages
      </h2>
      <p className="text-xs text-[var(--ff-text-tertiary)] mb-6">
        These messages appear at the bottom of printed and emailed documents. Leave blank to omit.
      </p>

      <div className="space-y-5">
        {MESSAGE_FIELDS.map(({ key, label, placeholder }) => (
          <div key={key}>
            <label className={LABEL_CLS}>{label}</label>
            <textarea
              className={TEXTAREA_CLS}
              rows={3}
              placeholder={placeholder}
              value={messages[key] ?? ''}
              onChange={e => onMessageChange(key, e.target.value)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
