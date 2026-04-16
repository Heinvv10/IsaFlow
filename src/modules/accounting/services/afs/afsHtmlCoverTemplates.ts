// src/modules/accounting/services/afs/afsHtmlCoverTemplates.ts

import type { BrandProfile } from './afsTypes';

export interface CoverContext {
  primaryColour: string;
  secondaryColour: string;
  logoUrl: string | null;
  companyName: string;
  registrationNumber: string;
  periodEnd: string;
  coverPhotoUrl?: string;
}

// ── Logo helper ───────────────────────────────────────────────────────────────

function logoImg(logoUrl: string | null): string {
  if (!logoUrl) return '';
  return `<img src="${logoUrl}" alt="Company logo"/>`;
}

// ── Cover style renderers ─────────────────────────────────────────────────────

function renderClassicCover(ctx: CoverContext): string {
  const bgStyle = ctx.coverPhotoUrl
    ? `background-image:url(${ctx.coverPhotoUrl})`
    : `background:${ctx.primaryColour}`;

  return `<div class="cover-page cover-classic" style="${bgStyle}">
  <div class="cover-overlay"></div>
  <div class="cover-logo">${logoImg(ctx.logoUrl)}</div>
  <h1 class="cover-title">Annual Financial Statements</h1>
  <p class="cover-period">For the year ended ${ctx.periodEnd}</p>
  <p class="cover-company">${ctx.companyName}</p>
  <p class="cover-reg">Registration No: ${ctx.registrationNumber}</p>
</div>`;
}

function renderModernCover(ctx: CoverContext): string {
  const photoStyle = ctx.coverPhotoUrl
    ? `background-image:url(${ctx.coverPhotoUrl})`
    : `background:${ctx.secondaryColour}`;

  return `<div class="cover-page cover-modern">
  <div class="cover-panel" style="background:${ctx.primaryColour}">
    <div class="cover-logo">${logoImg(ctx.logoUrl)}</div>
    <h1 class="cover-title">Annual Financial Statements</h1>
    <p class="cover-period">For the year ended ${ctx.periodEnd}</p>
    <p class="cover-company">${ctx.companyName}</p>
    <p class="cover-reg">Registration No: ${ctx.registrationNumber}</p>
  </div>
  <div class="cover-photo" style="${photoStyle}"></div>
</div>`;
}

function renderBoldCover(ctx: CoverContext): string {
  return `<div class="cover-page cover-bold" style="background:${ctx.primaryColour}">
  <svg class="cover-geo" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
    <pattern id="geo" width="60" height="60" patternUnits="userSpaceOnUse">
      <circle cx="30" cy="30" r="20" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
    </pattern>
    <rect width="100%" height="100%" fill="url(#geo)"/>
  </svg>
  <div class="cover-logo">${logoImg(ctx.logoUrl)}</div>
  <h1 class="cover-title" style="color:#ffffff">Annual Financial Statements</h1>
  <p class="cover-period" style="color:${ctx.secondaryColour}">For the year ended ${ctx.periodEnd}</p>
  <p class="cover-company" style="color:#ffffff">${ctx.companyName}</p>
  <p class="cover-reg" style="color:#ffffff">Registration No: ${ctx.registrationNumber}</p>
</div>`;
}

function renderMinimalCover(ctx: CoverContext): string {
  return `<div class="cover-page cover-minimal">
  <div class="cover-logo">${logoImg(ctx.logoUrl)}</div>
  <hr class="cover-rule" style="border-color:${ctx.primaryColour}"/>
  <h1 class="cover-title" style="color:${ctx.primaryColour}">Annual Financial Statements</h1>
  <p class="cover-period">For the year ended ${ctx.periodEnd}</p>
  <p class="cover-company">${ctx.companyName}</p>
  <p class="cover-reg">Registration No: ${ctx.registrationNumber}</p>
</div>`;
}

// ── Public export ─────────────────────────────────────────────────────────────

export function renderCoverHtml(
  coverStyle: BrandProfile['coverStyle'],
  context: CoverContext,
): string {
  switch (coverStyle) {
    case 'classic':
      return renderClassicCover(context);
    case 'modern':
      return renderModernCover(context);
    case 'bold':
      return renderBoldCover(context);
    case 'minimal':
      return renderMinimalCover(context);
    default:
      return renderClassicCover(context);
  }
}
