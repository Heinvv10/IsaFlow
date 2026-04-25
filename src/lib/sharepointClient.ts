/**
 * SharePoint REST API client (app-only, client credentials).
 *
 * Uses the SharePoint REST API (not Graph) with an Azure AD client-credentials
 * token. The token is cached in a module-level variable and auto-refreshed when
 * within 5 minutes of expiry so each request pays no round-trip cost.
 *
 * Required env vars:
 *   AZURE_CLIENT_ID       -- Azure AD app registration client ID
 *   AZURE_CLIENT_SECRET   -- Azure AD app registration client secret
 *   AZURE_TENANT_ID       -- Azure AD tenant ID (e.g. blitzfibre.onmicrosoft.com)
 *   SHAREPOINT_SITE_URL   -- Full site URL (e.g. https://blitzfibre.sharepoint.com/sites/VelocityFinance)
 */

import { log } from '@/lib/logger';

// ---- Types ------------------------------------------------------------------

export interface SpFile {
  name: string;
  serverRelativeUrl: string;
  size: number;
  modified: string;
}

export interface SpFolder {
  name: string;
  serverRelativeUrl: string;
  itemCount: number;
}

export interface SpFolderContents {
  files: SpFile[];
  folders: SpFolder[];
}

interface TokenCache {
  token: string;
  expiresAt: number; // Unix epoch ms
}

// ---- Module-level token cache -----------------------------------------------

let _tokenCache: TokenCache | null = null;
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// ---- Env helpers ------------------------------------------------------------

function requireSharePointEnv(): {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  siteUrl: string;
} {
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID;
  const siteUrl = process.env.SHAREPOINT_SITE_URL;

  if (!clientId || !clientSecret || !tenantId || !siteUrl) {
    throw new Error(
      'SharePoint not configured. Set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, and SHAREPOINT_SITE_URL.',
    );
  }

  return { clientId, clientSecret, tenantId, siteUrl };
}

// ---- Token management -------------------------------------------------------

export async function getAccessToken(): Promise<string> {
  const now = Date.now();

  if (_tokenCache && _tokenCache.expiresAt - now > REFRESH_BEFORE_EXPIRY_MS) {
    return _tokenCache.token;
  }

  const { clientId, clientSecret, tenantId, siteUrl } = requireSharePointEnv();

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const siteHost = new URL(siteUrl).hostname;
  const scope = `https://${siteHost}/.default`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    log.error('SharePoint token fetch failed', { status: res.status, body: text }, 'sharepoint-client');
    throw new Error(`SharePoint token fetch failed: ${res.status}`);
  }

  const json = await res.json() as { access_token: string; expires_in: number };

  _tokenCache = {
    token: json.access_token,
    expiresAt: now + json.expires_in * 1000,
  };

  log.info('SharePoint access token refreshed', {}, 'sharepoint-client');
  return _tokenCache.token;
}

// ---- XML parsing helpers ----------------------------------------------------

function extractXmlEntries(xml: string, markerTag: string): string[] {
  const regex = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
  const entries: string[] = [];
  let match = regex.exec(xml);
  while (match !== null) {
    const content = match[1] ?? '';
    if (content.includes(markerTag)) {
      entries.push(content);
    }
    match = regex.exec(xml);
  }
  return entries;
}

function extractSingleValue(xml: string, tag: string): string {
  const regex = new RegExp(`<[dm]:${tag}>([^<]*)<\/[dm]:${tag}>`);
  const match = regex.exec(xml);
  return match?.[1] ?? '';
}

// ---- API functions ----------------------------------------------------------

function normalizePath(siteUrl: string, serverRelativePath: string): string {
  // If already a full server-relative path (starts with /), use as-is.
  if (serverRelativePath.startsWith('/')) return serverRelativePath;
  // Otherwise prepend the site path derived from siteUrl.
  const sitePath = new URL(siteUrl).pathname.replace(/\/$/, '');
  return `${sitePath}/${serverRelativePath}`;
}

export async function listFolder(serverRelativePath: string): Promise<SpFolderContents> {
  const { siteUrl } = requireSharePointEnv();
  const token = await getAccessToken();

  const fullPath = normalizePath(siteUrl, serverRelativePath);
  const encodedPath = encodeURIComponent(fullPath);

  const [filesRes, foldersRes] = await Promise.all([
    fetch(
      `${siteUrl}/_api/web/GetFolderByServerRelativeUrl('${encodedPath}')/Files`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/atom+xml' } },
    ),
    fetch(
      `${siteUrl}/_api/web/GetFolderByServerRelativeUrl('${encodedPath}')/Folders`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/atom+xml' } },
    ),
  ]);

  if (!filesRes.ok) {
    const text = await filesRes.text();
    log.error('SharePoint files list failed', { status: filesRes.status, path: fullPath, body: text }, 'sharepoint-client');
    throw new Error(`SharePoint list failed: ${filesRes.status}`);
  }

  if (!foldersRes.ok) {
    const text = await foldersRes.text();
    log.error('SharePoint folders list failed', { status: foldersRes.status, path: fullPath, body: text }, 'sharepoint-client');
    throw new Error(`SharePoint folders list failed: ${foldersRes.status}`);
  }

  const filesXml = await filesRes.text();
  const foldersXml = await foldersRes.text();

  return {
    files: parseFilesXml(filesXml),
    folders: parseFoldersXml(foldersXml),
  };
}

function parseFilesXml(xml: string): SpFile[] {
  return extractXmlEntries(xml, 'd:Name').map((entry) => ({
    name: extractSingleValue(entry, 'Name'),
    serverRelativeUrl: extractSingleValue(entry, 'ServerRelativeUrl'),
    size: parseInt(extractSingleValue(entry, 'Length') || '0', 10),
    modified: extractSingleValue(entry, 'TimeLastModified'),
  })).filter((f) => f.name !== '');
}

function parseFoldersXml(xml: string): SpFolder[] {
  return extractXmlEntries(xml, 'd:Name').map((entry) => ({
    name: extractSingleValue(entry, 'Name'),
    serverRelativeUrl: extractSingleValue(entry, 'ServerRelativeUrl'),
    itemCount: parseInt(extractSingleValue(entry, 'ItemCount') || '0', 10),
  })).filter((f) => f.name !== '' && f.name !== 'Forms');
}

export async function downloadFile(
  serverRelativeUrl: string,
): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
  const { siteUrl } = requireSharePointEnv();
  const token = await getAccessToken();

  const encodedUrl = encodeURIComponent(serverRelativeUrl);
  const downloadUrl = `${siteUrl}/_api/web/GetFileByServerRelativeUrl('${encodedUrl}')/$value`;

  const res = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    log.error('SharePoint file download failed', { status: res.status, serverRelativeUrl }, 'sharepoint-client');
    throw new Error(`SharePoint download failed: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const fileName = serverRelativeUrl.split('/').pop() ?? 'document';

  return { buffer, contentType, fileName };
}
