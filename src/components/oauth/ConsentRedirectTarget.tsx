import { CornerDownRight } from 'lucide-react';
import { describeRedirectTarget } from '@/lib/auth/consentRedirectTarget';

/**
 * Says where an authorisation would actually be sent.
 *
 * The app's name above this line is whatever the app asked to be called. The
 * redirect target is registered up front and checked against that registration
 * before the page renders, so it is the one identity line here that a hostile
 * app cannot simply choose.
 */
export function ConsentRedirectTarget({ redirectUri }: { redirectUri: string }) {
  const target = describeRedirectTarget(redirectUri);
  if (target.kind === 'unknown') return null;

  return (
    <p className="text-xs text-slate-400 mt-1.5 flex items-start gap-1.5">
      <CornerDownRight className="h-3.5 w-3.5 shrink-0 mt-px text-slate-500" />
      <span>
        Sends your authorisation to{' '}
        <span className="font-medium text-slate-200 break-all">
          {target.kind === 'web' ? target.host : 'a program on this computer — IsaFlow cannot tell you which one'}
        </span>
      </span>
    </p>
  );
}
