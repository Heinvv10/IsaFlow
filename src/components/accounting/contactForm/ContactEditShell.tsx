/** The frame of a contact edit page: header, the form, Cancel / Save. The page owns loading and saving. */
import type { FormEvent, ReactNode } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, Loader2, Save } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';

interface Props {
  title: string;
  subtitle: string;
  backHref: string;
  icon: LucideIcon;
  iconClass: string;
  saving: boolean;
  onSubmit: () => void;
  saveLabel: string;
  children: ReactNode;
}

export function ContactEditShell({ title, subtitle, backHref, icon: Icon, iconClass, saving, onSubmit, saveLabel, children }: Props) {
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit();
  }
  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href={backHref} aria-label="Back" className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] transition-colors">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className={`p-2 rounded-lg ${iconClass}`}><Icon className="h-6 w-6" /></div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">{title}</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">{subtitle}</p>
            </div>
          </div>
        </div>
        <div className="p-6 max-w-3xl">
          <form onSubmit={submit} noValidate>
            {children}
            <div className="flex items-center justify-end gap-3 mt-6">
              <Link href={backHref} className="px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium transition-colors">
                Cancel
              </Link>
              <button type="submit" disabled={saving}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {saving ? 'Saving...' : saveLabel}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
