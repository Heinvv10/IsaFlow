/**
 * FirstContactWizard — modal shown the first time a user creates a contact.
 * Explains contacts, lets them choose Customer / Supplier, or import CSV.
 * Dismissed via user_preferences key: first_contact_wizard_dismissed
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import { Users, Building2, Upload } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useFirstUseWizard } from '@/hooks/useFirstUseWizard';

const WIZARD_KEY = 'first_contact_wizard';

interface ChoiceCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}

function ChoiceCard({ icon, title, description, onClick }: ChoiceCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-3 p-6 rounded-xl border-2 border-gray-300 dark:border-gray-600 hover:border-teal-500 dark:hover:border-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-all text-center group w-full"
    >
      <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center group-hover:bg-teal-100 dark:group-hover:bg-teal-800/40 transition-colors">
        {icon}
      </div>
      <div>
        <p className="font-semibold text-gray-800 dark:text-gray-100 text-sm">{title}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
      </div>
    </button>
  );
}

export function FirstContactWizard() {
  const { shouldShow, dismiss, loading } = useFirstUseWizard(WIZARD_KEY);
  const [dontShow, setDontShow] = useState(false);
  const router = useRouter();

  if (loading || !shouldShow) return null;

  const handleChoice = (path: string) => {
    dismiss();
    void router.push(path);
  };

  const handleGotIt = () => {
    dismiss();
  };

  return (
    <Modal open title="Welcome to Contacts" onClose={dismiss} size="md">
      <Modal.Body>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-6 leading-relaxed">
          Contacts are the people and businesses you work with — your{' '}
          <strong className="text-gray-800 dark:text-gray-100">customers</strong> (who you invoice) and your{' '}
          <strong className="text-gray-800 dark:text-gray-100">suppliers</strong> (who you pay). What would you like to do?
        </p>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <ChoiceCard
            icon={<Users className="w-6 h-6 text-teal-600 dark:text-teal-400" />}
            title="Create a Customer"
            description="Someone you invoice for goods or services"
            onClick={() => handleChoice('/accounting/clients/new')}
          />
          <ChoiceCard
            icon={<Building2 className="w-6 h-6 text-teal-600 dark:text-teal-400" />}
            title="Create a Supplier"
            description="A vendor or business you purchase from"
            onClick={() => handleChoice('/accounting/suppliers/new')}
          />
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
          <button
            type="button"
            onClick={() => handleChoice('/accounting/clients?import=true')}
            className="flex items-center gap-2 text-sm text-teal-600 dark:text-teal-400 hover:text-teal-700 dark:hover:text-teal-300 transition-colors"
          >
            <Upload className="w-4 h-4" />
            Import contacts from CSV
          </button>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <input
            id="first-contact-dont-show"
            type="checkbox"
            checked={dontShow}
            onChange={e => setDontShow(e.target.checked)}
            className="rounded border-gray-400 text-teal-600 focus:ring-teal-500"
          />
          <label htmlFor="first-contact-dont-show" className="text-xs text-gray-500 dark:text-gray-400 cursor-pointer">
            Don&apos;t show this again
          </label>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={handleGotIt}>
          Maybe later
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
