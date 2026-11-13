/**
 * Google Drive upload, using the Drive API v3.
 *
 * This makes `cloud_storage` a real upload instead of a local ZIP. The Drive
 * API is free; you only need an OAuth client from Google Cloud Console.
 *
 * Docs: https://developers.google.com/workspace/drive/api/reference/rest/v3
 *
 * Setup, once:
 *   1. Google Cloud Console -> APIs & Services -> enable "Google Drive API".
 *   2. Credentials -> Create OAuth client ID -> Web application.
 *      Add the redirect URI this app prints at /api/direk/drive/status.
 *   3. Put the client id and secret in the SETUP panel (or GDRIVE_CLIENT_ID /
 *      GDRIVE_CLIENT_SECRET), then open /api/direk/drive/auth to consent.
 *
 * Scope is `drive.file`, so the app can only see the files it creates. It cannot
 * read anything else in your Drive.
 */

import fs from 'node:fs';
import path from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

export interface DriveTokens {
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
}

export function tokenFile(): string {
  return process.env.GDRIVE_TOKEN_FILE || path.join(process.cwd(), 'gdrive.token.json');
}

export function readTokens(): DriveTokens {
  try {
    return JSON.parse(fs.readFileSync(tokenFile(), 'utf8')) as DriveTokens;
  } catch {
    return {};
  }
}

export function writeTokens(tokens: DriveTokens): void {
  fs.writeFileSync(tokenFile(), JSON.stringify(tokens, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function driveConfigured(): boolean {
  return Boolean(process.env.GDRIVE_CLIENT_ID && process.env.GDRIVE_CLIENT_SECRET);
}

/** The redirect URI Google must know about. Overridable for a fixed domain. */
export function redirectUri(baseUrl?: string): string {
  if (process.env.GDRIVE_REDIRECT_URI) return process.env.GDRIVE_REDIRECT_URI;
  const base = (baseUrl || process.env.APP_BASE_URL || 'http://127.0.0.1:12000').replace(/\/+$/, '');
  return `${base}/api/direk/drive/callback`;
}

/** The consent URL to send the user to. */
export function authUrl(redirect: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GDRIVE_CLIENT_ID || '',
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export function driveStatus(baseUrl?: string): {
  configured: boolean;
  authorized: boolean;
  redirect_uri: string;
  folder_id: string | null;
} {
  return {
    configured: driveConfigured(),
    authorized: Boolean(readTokens().refresh_token),
    redirect_uri: redirectUri(baseUrl),
    folder_id: process.env.GDRIVE_FOLDER_ID || null,
  };
}

/** Trade the consent code for a refresh token and keep it. */
export async function exchangeCode(code: string, redirect: string): Promise<void> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GDRIVE_CLIENT_ID || '',
    client_secret: process.env.GDRIVE_CLIENT_SECRET || '',
    redirect_uri: redirect,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as DriveTokens;
  if (!json.refresh_token) {
    throw new Error('Walang refresh_token. Alisin ang dating access sa Google account at subukan muli.');
  }
  writeTokens({
    refresh_token: json.refresh_token,
    access_token: json.access_token,
    expires_at: Date.now() + (json as any).expires_in * 1000,
  });
}

/** A live access token, refreshed when needed. */
export async function accessToken(): Promise<string> {
  const tokens = readTokens();
  if (tokens.access_token && tokens.expires_at && tokens.expires_at - 60000 > Date.now()) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) throw new Error('Hindi pa naka-authorize ang Google Drive. Buksan ang /api/direk/drive/auth.');
  const body = new URLSearchParams({
    refresh_token: tokens.refresh_token,
    client_id: process.env.GDRIVE_CLIENT_ID || '',
    client_secret: process.env.GDRIVE_CLIENT_SECRET || '',
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as DriveTokens;
  writeTokens({
    refresh_token: tokens.refresh_token,
    access_token: json.access_token,
    expires_at: Date.now() + (json as any).expires_in * 1000,
  });
  return json.access_token as string;
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

/** Find a folder by name, or create it. Returns its id. */
export async function ensureFolder(name: string): Promise<string> {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false`;
  const found = await driveFetch(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  if (found.ok) {
    const json = (await found.json()) as { files?: { id: string }[] };
    if (json.files?.length) return json.files[0].id;
  }
  const created = await driveFetch(`${FILES_URL}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!created.ok) throw new Error(`Hindi magawa ang folder (${created.status}): ${await created.text()}`);
  return ((await created.json()) as { id: string }).id;
}

export interface DriveFile {
  id: string;
  name: string;
  webViewLink?: string;
}

/**
 * Upload bytes with a resumable upload, which is the only reliable way for
 * large video files. Returns the file id and a link you can open.
 */
export async function uploadFile(
  name: string,
  mime: string,
  data: Buffer,
  opts: { folderId?: string } = {},
): Promise<DriveFile> {
  const folderId = opts.folderId || process.env.GDRIVE_FOLDER_ID || (await ensureFolder(process.env.GDRIVE_FOLDER_NAME || 'Direk'));

  const start = await driveFetch(`${UPLOAD_URL}?uploadType=resumable&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(data.length),
    },
    body: JSON.stringify({ name, parents: folderId ? [folderId] : undefined }),
  });
  if (!start.ok) throw new Error(`Hindi masimulan ang upload (${start.status}): ${await start.text()}`);
  const session = start.headers.get('location');
  if (!session) throw new Error('Walang upload session mula sa Google.');

  const put = await fetch(session, {
    method: 'PUT',
    headers: { 'Content-Type': mime, 'Content-Length': String(data.length) },
    body: new Uint8Array(data),
  });
  if (!put.ok) throw new Error(`Nabigo ang upload (${put.status}): ${await put.text()}`);
  return (await put.json()) as DriveFile;
}

/** List the files this app created in Drive. */
export async function listDriveFiles(): Promise<DriveFile[]> {
  const res = await driveFetch(`${FILES_URL}?pageSize=50&orderBy=createdTime desc&fields=files(id,name,webViewLink)&spaces=drive`);
  if (!res.ok) throw new Error(`Hindi makuha ang listahan (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { files?: DriveFile[] };
  return json.files ?? [];
}
