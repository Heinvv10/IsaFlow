/**
 * SharePoint client using Microsoft Graph API (app-only, client credentials).
 *
 * Required env vars:
 *   AZURE_CLIENT_ID       -- Azure AD app registration client ID
 *   AZURE_CLIENT_SECRET   -- Azure AD app registration client secret
 *   AZURE_TENANT_ID       -- Azure AD tenant ID
 *   SHAREPOINT_SITE_URL   -- Full site URL (e.g. https://blitzfibre.sharepoint.com/sites/VelocityFinance)
 */

import { log } from '@/lib/logger';

export interface SpFile {
  name: string;
  serverRelativeUrl: string;
  size: number;
  modified: string;
  downloadUrl?: string;
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
  expiresAt: number;
}

interface DriveCache {
  siteId: string;
  driveId: string;
}

let _tokenCache: TokenCache | null = null;
let _driveCache: DriveCache | null = null;
const REFRESH_BEFORE_MS = 5 * 60 * 1000;

function requireEnv(): { clientId: string; clientSecret: string; tenantId: string; siteUrl: string } {
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID;
  const siteUrl = process.env.SHAREPOINT_SITE_URL;
  if (!clientId || !clientSecret || !tenantId || !siteUrl) {
    throw new Error('SharePoint not configured. Set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, and SHAREPOINT_SITE_URL.');
  }
  return { clientId, clientSecret, tenantId, siteUrl };
}

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt - now > REFRESH_BEFORE_MS) return _tokenCache.token;

  const { clientId, clientSecret, tenantId } = requireEnv();
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    log.error('SharePoint token failed', { status: res.status, body: text }, 'sharepoint');
    throw new Error(`SharePoint token failed: ${res.status}`);
  }

  const json = await res.json() as { access_token: string; expires_in: number };
  _tokenCache = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
  log.info('SharePoint token refreshed', {}, 'sharepoint');
  return _tokenCache.token;
}

async function getDriveId(): Promise<string> {
  if (_driveCache) return _driveCache.driveId;

  const { siteUrl } = requireEnv();
  const token = await getAccessToken();
  const parsed = new URL(siteUrl);
  const sitePath = parsed.pathname; // e.g. /sites/VelocityFinance

  const siteRes = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${parsed.hostname}:${sitePath}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!siteRes.ok) throw new Error(`Graph site lookup failed: ${siteRes.status}`);
  const site = await siteRes.json() as { id: string };

  const drivesRes = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${site.id}/drives`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!drivesRes.ok) throw new Error(`Graph drives lookup failed: ${drivesRes.status}`);
  const drives = await drivesRes.json() as { value: { id: string; name: string }[] };
  const docsDrive = drives.value.find(d => d.name === 'Documents') ?? drives.value[0];
  if (!docsDrive) throw new Error('No document drive found on SharePoint site');

  _driveCache = { siteId: site.id, driveId: docsDrive.id };
  return _driveCache.driveId;
}

interface GraphDriveItem {
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  parentReference?: { path?: string };
  folder?: { childCount: number };
  file?: { mimeType?: string };
  '@microsoft.graph.downloadUrl'?: string;
}

function itemToServerRelativeUrl(item: GraphDriveItem, siteUrl: string): string {
  const parsed = new URL(siteUrl);
  const parentPath = item.parentReference?.path ?? '';
  // parentPath looks like: /drives/{driveId}/root:/Shared Documents/Invoices
  const afterRoot = parentPath.replace(/^.*?root:/, '');
  return `${parsed.pathname}${afterRoot}/${item.name}`;
}

export async function listFolder(folderPath: string): Promise<SpFolderContents> {
  const { siteUrl } = requireEnv();
  const token = await getAccessToken();
  const driveId = await getDriveId();

  // Normalize: strip leading /sites/... prefix so we get just the relative path within the drive
  const parsed = new URL(siteUrl);
  const sitePath = parsed.pathname.replace(/\/$/, '');
  let relativePath = folderPath;
  if (relativePath.startsWith(sitePath + '/')) {
    relativePath = relativePath.slice(sitePath.length + 1);
  } else if (relativePath.startsWith('/')) {
    // full server-relative path from a different site prefix - strip leading /
    relativePath = relativePath.replace(/^\/[^/]+\/[^/]+\//, '');
  }

  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodedPath}:/children?$top=200`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    log.error('Graph folder list failed', { status: res.status, path: relativePath, body: text }, 'sharepoint');
    throw new Error(`SharePoint folder list failed: ${res.status}`);
  }

  const json = await res.json() as { value: GraphDriveItem[] };
  const files: SpFile[] = [];
  const folders: SpFolder[] = [];

  for (const item of json.value ?? []) {
    if (item.folder) {
      folders.push({
        name: item.name,
        serverRelativeUrl: itemToServerRelativeUrl(item, siteUrl),
        itemCount: item.folder.childCount,
      });
    } else {
      files.push({
        name: item.name,
        serverRelativeUrl: itemToServerRelativeUrl(item, siteUrl),
        size: item.size ?? 0,
        modified: item.lastModifiedDateTime ?? '',
        downloadUrl: item['@microsoft.graph.downloadUrl'],
      });
    }
  }

  return { files, folders };
}

export async function downloadFile(
  serverRelativeUrl: string,
): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
  const { siteUrl } = requireEnv();
  const token = await getAccessToken();
  const driveId = await getDriveId();

  const parsed = new URL(siteUrl);
  const sitePath = parsed.pathname.replace(/\/$/, '');
  let relativePath = serverRelativeUrl;
  if (relativePath.startsWith(sitePath + '/')) {
    relativePath = relativePath.slice(sitePath.length + 1);
  } else if (relativePath.startsWith('/')) {
    relativePath = relativePath.replace(/^\/[^/]+\/[^/]+\//, '');
  }

  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');

  // Get item metadata to find download URL
  const metaRes = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodedPath}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) throw new Error(`Graph item lookup failed: ${metaRes.status}`);
  const meta = await metaRes.json() as GraphDriveItem & { '@microsoft.graph.downloadUrl'?: string };

  const downloadUrl = meta['@microsoft.graph.downloadUrl'];
  if (!downloadUrl) throw new Error('No download URL for item');

  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) throw new Error(`File download failed: ${dlRes.status}`);

  const arrayBuffer = await dlRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = dlRes.headers.get('content-type') ?? 'application/octet-stream';
  const fileName = serverRelativeUrl.split('/').pop() ?? 'document';

  return { buffer, contentType, fileName };
}
