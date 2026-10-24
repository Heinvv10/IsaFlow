/**
 * FieldHelp — an (i) button that shows contextual help for a field or section, with an optional
 * "Learn more" link. The help text is always in the DOM (hidden until opened) so the field can
 * reference it with aria-describedby. Opens on keyboard focus, hover or click; closes on Esc,
 * on focus leaving, and when the pointer leaves (unless focus is still inside, so the link stays
 * reachable by keyboard).
 */
import * as React from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface FieldHelpContent {
  text: string;
  /** "Learn more" target. http(s) links open in a new tab. */
  href?: string;
}

export interface FieldHelpProps {
  help: FieldHelpContent;
  /** Id of the element holding the help text; the field puts it in aria-describedby. */
  textId: string;
  /** What the help is about, for the button's accessible name ("Help: Amount"). */
  subject: string;
}

export function FieldHelp({ help, textId, subject }: FieldHelpProps) {
  const [open, setOpen] = React.useState(false);
  const wrapperRef = React.useRef<HTMLSpanElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      if (wrapperRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
    };
    // window capture runs before a surrounding dialog's document listener: Esc dismisses the tip first.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const external = help.href !== undefined && /^https?:/i.test(help.href);

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!wrapperRef.current?.contains(document.activeElement)) setOpen(false);
      }}
      onBlur={(e) => {
        if (!wrapperRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Help: ${subject}`}
        aria-expanded={open}
        aria-controls={textId}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        className="ff-focus-ring inline-flex rounded-full p-0.5 text-gray-600 hover:text-teal-700 dark:text-gray-400 dark:hover:text-teal-300"
      >
        <Info size={14} aria-hidden="true" />
      </button>
      <span
        id={textId}
        role="tooltip"
        hidden={!open}
        className={cn(
          'absolute left-0 top-full z-20 mt-1 w-64 rounded-md border border-gray-200 bg-white p-2.5 text-xs font-normal',
          'text-gray-800 shadow-lg dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100',
        )}
      >
        {help.text}
        {help.href && (
          <a
            href={help.href}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            className="ff-focus-ring mt-1.5 block font-medium text-teal-700 underline dark:text-teal-300"
          >
            Learn more
            {external && <span className="sr-only"> (opens in a new tab)</span>}
          </a>
        )}
      </span>
    </span>
  );
}
