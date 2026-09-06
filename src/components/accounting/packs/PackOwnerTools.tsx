/**
 * The owner-side surfaces on the report-packs page: minting a share link, and
 * the commentary filed against the pack on screen.
 *
 * Extracted from `pages/accounting/reports/report-packs.tsx`, which sits at
 * the 300-line ceiling once WS2's print dispatcher and WS3's sharing mounts
 * share it. Two components rather than one, because their mount points are
 * not adjacent: the Share button belongs in the header toolbar next to the
 * downloads, the commentary panel belongs under the last pack section. Each
 * reads the role itself, so the page passes only the pack it is showing.
 *
 * Both gates decide what is DRAWN. The routes decide what is allowed, and
 * they enforce the same roles server-side regardless of what renders here.
 */
import { useState } from 'react';
import { Share2 } from 'lucide-react';
import { ShareLinkDialog } from '@/components/accounting/share/ShareLinkDialog';
import { CommentaryPanel } from '@/components/accounting/commentary/CommentaryPanel';
import { useCompany } from '@/contexts/CompanyContext';
import { canReadSharingSurface } from '@/modules/accounting/services/reports/sharingAccess';
import type { SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';

/** Minting a share link and approving commentary are owner/admin decisions —
 *  the same two roles `pages/api/accounting/share/links.ts` and the commentary
 *  approve/reject routes enforce server-side. */
const APPROVER_ROLES = ['owner', 'admin'];

function isApprover(companyRole: string | null): boolean {
  return APPROVER_ROLES.includes(companyRole ?? '');
}

/** The Share control and the dialog it opens. Renders nothing at all for a
 *  role that could not mint a link. */
export function PackShareButton({ params }: { params: SharePackParams }) {
  const [open, setOpen] = useState(false);
  const { companyRole } = useCompany();
  if (!isApprover(companyRole)) return null;

  return (
    <>
      <button onClick={() => setOpen(true)} className="ff-btn-secondary flex items-center gap-1 text-sm">
        <Share2 className="h-4 w-4" />
        Share
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-6 pt-24">
          <ShareLinkDialog params={params} onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}

/** Commentary for the pack on screen. `canReadSharingSurface` is the same
 *  predicate the commentary route applies to its GET arm: a surface that could
 *  only answer 403 is not drawn, so a viewer opening the page gets no panel
 *  rather than an error under the pack. */
export function PackCommentary({ params }: { params: SharePackParams }) {
  const { companyRole } = useCompany();
  if (!canReadSharingSurface(companyRole)) return null;

  return (
    <CommentaryPanel
      sectionRef="commentary"
      mode="internal"
      canApprove={isApprover(companyRole)}
      params={params}
    />
  );
}
