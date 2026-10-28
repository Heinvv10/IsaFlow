import type { ReactNode } from 'react';
import { AlertTriangle, Info, Lightbulb } from 'lucide-react';

const STYLES = {
  info: { box: 'border-blue-200 bg-blue-50 text-blue-950', icon: Info, iconClass: 'text-blue-600', label: 'Note' },
  tip: { box: 'border-teal-200 bg-teal-50 text-teal-950', icon: Lightbulb, iconClass: 'text-teal-600', label: 'Tip' },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-950', icon: AlertTriangle, iconClass: 'text-amber-600', label: 'Warning' },
} as const;

interface Props {
  type?: keyof typeof STYLES;
  title?: string;
  children: ReactNode;
}

export function Callout({ type = 'info', title, children }: Props) {
  const s = STYLES[type];
  if (!s) throw new Error(`Invalid <Callout type="${String(type)}">: use info, tip or warning`);
  const Icon = s.icon;
  return (
    <aside className={`not-prose my-8 flex gap-4 rounded-2xl border p-5 ${s.box}`} role="note">
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${s.iconClass}`} aria-hidden="true" />
      <div className="min-w-0 space-y-2 leading-relaxed [&_a]:underline [&_p]:m-0">
        <p className="font-semibold">{title ?? s.label}</p>
        {children}
      </div>
    </aside>
  );
}
