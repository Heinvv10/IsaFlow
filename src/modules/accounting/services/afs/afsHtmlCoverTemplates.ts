// src/modules/accounting/services/afs/afsHtmlCoverTemplates.ts

import type { BrandProfile } from './afsTypes';
import { escapeHtml } from './afsHtmlTableRenderer';

/** Escape a value for safe use inside an HTML attribute (e.g. src="..." style="...") */
function escapeAttr(str: string): string {
  return escapeHtml(str);
}

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
  return `<img src="${escapeAttr(logoUrl)}" alt="Company logo"/>`;
}

// ── Cover style renderers ─────────────────────────────────────────────────────

function renderClassicCover(ctx: CoverContext): string {
  const bgStyle = ctx.coverPhotoUrl
    ? `background-image:url(${escapeAttr(ctx.coverPhotoUrl)})`
    : `background:${escapeAttr(ctx.primaryColour)}`;

  return `<div class="cover-page cover-classic" style="${bgStyle}">
  <div class="cover-overlay"></div>
  <div class="cover-logo">${logoImg(ctx.logoUrl)}</div>
  <h1 class="cover-title">Annual Financial Statements</h1>
  <p class="cover-period">For the year ended ${escapeHtml(ctx.periodEnd)}</p>
  <p class="cover-company">${escapeHtml(ctx.companyName)}</p>
  <p class="cover-reg">Registration No: ${escapeHtml(ctx.registrationNumber)}</p>
</div>`;
}

function renderModernCover(ctx: CoverContext): string {
  const photoStyle = ctx.coverPhotoUrl
    ? `background-image:url(${escapeAttr(ctx.coverPhotoUrl)})`
    : `background:${escapeAttr(ctx.secondaryColour)}`;

  return `<div class="cover-page cover-modern">
  <div class="cover-panel" style="background:${escapeAttr(ctx.primaryColour)}">
    <div class="cover-logo">${logoImg(ctx.logoUrl)}</div>
    <h1 class="cover-title">Annual Financial Statements</h1>
    <p class="cover-period">For the year ended ${escapeHtml(ctx.periodEnd)}</p>
    <p class="cover-company">${escapeHtml(ctx.companyName)}</p>
    <p class="cover-reg">Registration No: ${escapeHtml(ctx.registrationNumber)}</p>
  </div>
  <div class="cover-photo" style="${photoStyle}"></div>
</div>`;
}

function renderBoldCover(ctx: CoverContext): string {
  return `<div class="cover-page cover-bold" style="background:${escapeAttr(ctx.primaryColour)}">
  <svg class="cover-geo" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
    <pattern id="geo" width="60" height="60" patternUnits="userSpaceOnUse">
      <circle cx="30" cy="30" r="20" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
    </pattern>
    <rect width="100%" height="100%" fill="url(#geo)"/>
  </svg>
  <div class="cover-logo">${logoImg(ctx.logoUrl)}</div>
  <h1 class="cover-title" style="color:#ffffff">Annual Financial Statements</h1>
  <p class="cover-period" style="color:${escapeAttr(ctx.secondaryColour)}">For the year ended ${escapeHtml(ctx.periodEnd)}</p>
  <p class="cover-company" style="color:#ffffff">${escapeHtml(ctx.companyName)}</p>
  <p class="cover-reg" style="color:#ffffff">Registration No: ${escapeHtml(ctx.registrationNumber)}</p>
</div>`;
}

function renderMinimalCover(ctx: CoverContext): string {
  return `<div class="cover-page cover-minimal">
  <div class="cover-logo">${logoImg(ctx.logoUrl)}</div>
  <hr class="cover-rule" style="border-color:${escapeAttr(ctx.primaryColour)}"/>
  <h1 class="cover-title" style="color:${escapeAttr(ctx.primaryColour)}">Annual Financial Statements</h1>
  <p class="cover-period">For the year ended ${escapeHtml(ctx.periodEnd)}</p>
  <p class="cover-company">${escapeHtml(ctx.companyName)}</p>
  <p class="cover-reg">Registration No: ${escapeHtml(ctx.registrationNumber)}</p>
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
