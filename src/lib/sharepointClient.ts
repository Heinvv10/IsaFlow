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

// "Shared Documents" is the display name for the drive root in SharePoint URLs.
// The Graph API drive root has no name — it maps to root/children, not root:/Shared Documents:/children.
const DRIVE_ROOT_DISPLAY_NAME = 'Shared Documents';

function itemDrivePath(item: GraphDriveItem): string {
  const parentPath = item.parentReference?.path ?? '';
  // parentPath: /drives/{id}/root: (root) or /drives/{id}/root:/Invoices (subfolder)
  const afterRoot = parentPath.replace(/^.*?root:/, '').replace(/^\//, '');
  return afterRoot ? `${DRIVE_ROOT_DISPLAY_NAME}/${afterRoot}/${item.name}` : `${DRIVE_ROOT_DISPLAY_NAME}/${item.name}`;
}

function toDriveRelativePath(folderPath: string, sitePath: string): string {
  let p = folderPath.trim();
  // Strip full server-relative prefix e.g. /sites/VelocityFinance/Shared Documents/Invoices
  if (p.startsWith(sitePath + '/')) p = p.slice(sitePath.length + 1);
  else if (p.startsWith('/')) p = p.replace(/^\/[^/]+\/[^/]+\//, '');
  // Strip the drive root display name — "Shared Documents" IS the drive root
  if (p === DRIVE_ROOT_DISPLAY_NAME || p === '') return '';
  if (p.startsWith(DRIVE_ROOT_DISPLAY_NAME + '/')) return p.slice(DRIVE_ROOT_DISPLAY_NAME.length + 1);
  return p;
}

export async function listFolder(folderPath: string): Promise<SpFolderContents> {
  const { siteUrl } = requireEnv();
  const token = await getAccessToken();
  const driveId = await getDriveId();

  const sitePath = new URL(siteUrl).pathname.replace(/\/$/, '');
  const relPath = toDriveRelativePath(folderPath, sitePath);

  // Empty relPath = drive root (the "Shared Documents" library itself)
  const url = relPath
    ? `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${relPath.split('/').map(encodeURIComponent).join('/')}:/children?$top=200`
    : `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children?$top=200`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    log.error('Graph folder list failed', { status: res.status, path: relPath, body: text }, 'sharepoint');
    throw new Error(`SharePoint folder list failed: ${res.status}`);
  }

  const json = await res.json() as { value: GraphDriveItem[] };
  const files: SpFile[] = [];
  const folders: SpFolder[] = [];

  for (const item of json.value ?? []) {
    if (item.folder) {
      folders.push({
        name: item.name,
        serverRelativeUrl: itemDrivePath(item),
        itemCount: item.folder.childCount,
      });
    } else {
      files.push({
        name: item.name,
        serverRelativeUrl: itemDrivePath(item),
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

  const sitePath = new URL(siteUrl).pathname.replace(/\/$/, '');
  const relPath = toDriveRelativePath(serverRelativeUrl, sitePath);
  const encodedPath = relPath.split('/').map(encodeURIComponent).join('/');

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
