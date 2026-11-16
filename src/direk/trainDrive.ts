/**
 * The Drive folder bridge for remote LoRA training.
 *
 * In `colab` mode the app and the Colab notebook never talk to each other
 * directly. They trade files inside one Drive folder, so a dropped Colab session
 * can be resumed from whatever is already on disk in Drive.
 *
 *   LORA_TRAINING/
 *     jobs/<job_id>/
 *       job.json        the app writes the config and the dataset location
 *       dataset/        the app writes the images and their captions
 *       status.json     the notebook writes state, epoch, progress, error
 *       cancel.flag     the app writes this to ask for a clean stop
 *       output/         the notebook writes the .safetensors here
 *       manifest.json   the notebook writes file names, sizes and sha256
 *
 * Two stores implement the same tiny interface:
 *
 *   FsDriveStore       `COLAB_DRIVE_ROOT` is a real folder. This is what Google
 *                      Drive for Desktop mounts, so it is the normal path on
 *                      Server-2 and it needs no API token.
 *   GoogleDriveStore   talks to the Drive API v3 by folder id, for a headless
 *                      box with no Drive mount. `COLAB_DRIVE_FOLDER_ID`.
 *
 * Nothing here invents a result: a missing file reads back as null and the
 * caller decides what that means.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The file operations the training protocol needs from a Drive folder. */
export interface DriveStore {
  readonly kind: 'fs' | 'gdrive';
  /** Read a file relative to the Drive root, or null when it does not exist. */
  read(rel: string): Promise<Buffer | null>;
  /** Create or overwrite a file relative to the Drive root. */
  write(rel: string, data: Buffer): Promise<void>;
  /** List file paths under a prefix, relative to the Drive root. */
  list(prefix: string): Promise<string[]>;
  /** Delete a file relative to the Drive root. Missing files are not an error. */
  remove(rel: string): Promise<void>;
}

/** Lowercase hex sha256 of a buffer, the form the manifest records. */
export function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Reject a relative path that would climb out of the Drive root. */
function safeRel(rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.split('/').includes('..')) throw new Error(`Path escapes the Drive root: ${rel}`);
  return norm;
}

/** A Drive folder that is a real directory, e.g. a Google Drive for Desktop mount. */
export class FsDriveStore implements DriveStore {
  readonly kind = 'fs' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private full(rel: string): string {
    const root = path.resolve(this.root);
    const p = path.resolve(root, safeRel(rel));
    if (p !== root && !p.startsWith(root + path.sep)) {
      throw new Error(`Path escapes the Drive root: ${rel}`);
    }
    return p;
  }

  async read(rel: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(this.full(rel));
    } catch {
      return null;
    }
  }

  async write(rel: string, data: Buffer): Promise<void> {
    const p = this.full(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }

  async list(prefix: string): Promise<string[]> {
    const base = safeRel(prefix).replace(/\/+$/, '');
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
        else out.push(childRel);
      }
    };
    walk(this.full(base), base);
    return out.sort();
  }

  async remove(rel: string): Promise<void> {
    try {
      fs.rmSync(this.full(rel), { force: true });
    } catch {
      /* already gone */
    }
  }
}

/** A fetch with a hard timeout, so a slow Drive never hangs a request. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * A Drive folder reached through the Drive API v3, for a box with no Drive
 * mount. Folder ids are resolved and created on demand and cached, so a deep
 * path costs one lookup the first time and nothing after.
 */
export class GoogleDriveStore implements DriveStore {
  readonly kind = 'gdrive' as const;
  private readonly folderIds = new Map<string, string>();
  private readonly rootFolderId: string;
  private readonly token: () => Promise<string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    rootFolderId: string,
    token: () => Promise<string>,
    fetchImpl: FetchLike = fetch as unknown as FetchLike,
    timeoutMs = Number(process.env.COLAB_DRIVE_TIMEOUT_MS) || 30000,
  ) {
    this.rootFolderId = rootFolderId;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.folderIds.set('', rootFolderId);
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.token()}`);
    return this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  private async folderId(relDir: string): Promise<string> {
    const norm = safeRel(relDir).replace(/\/+$/, '');
    const cached = this.folderIds.get(norm);
    if (cached) return cached;
    const parts = norm ? norm.split('/') : [];
    let parent = this.rootFolderId;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      const hit = this.folderIds.get(acc);
      if (hit) {
        parent = hit;
        continue;
      }
      parent = await this.findOrCreateFolder(part, parent);
      this.folderIds.set(acc, parent);
    }
    return parent;
  }

  private async findOrCreateFolder(name: string, parentId: string): Promise<string> {
    const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;
    const found = await this.call(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
    if (found.ok) {
      const json = (await found.json()) as { files?: { id: string }[] };
      if (json.files?.length) return json.files[0].id;
    }
    const created = await this.call(`${FILES_URL}?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    if (!created.ok) throw new Error(`Hindi magawa ang Drive folder '${name}' (${created.status}).`);
    return ((await created.json()) as { id: string }).id;
  }

  private async findFile(name: string, parentId: string): Promise<string | null> {
    const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
    const res = await this.call(`${FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
    if (!res.ok) return null;
    const json = (await res.json()) as { files?: { id: string }[] };
    return json.files?.length ? json.files[0].id : null;
  }

  async read(rel: string): Promise<Buffer | null> {
    const norm = safeRel(rel);
    const parent = await this.folderId(path.posix.dirname(norm));
    const id = await this.findFile(path.posix.basename(norm), parent);
    if (!id) return null;
    const res = await this.call(`${FILES_URL}/${id}?alt=media`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  async write(rel: string, data: Buffer): Promise<void> {
    const norm = safeRel(rel);
    const parent = await this.folderId(path.posix.dirname(norm));
    const name = path.posix.basename(norm);
    const existing = await this.findFile(name, parent);
    if (existing) {
      const res = await this.call(`${UPLOAD_URL}/${existing}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(data),
      });
      if (!res.ok) throw new Error(`Nabigo ang Drive update (${res.status}).`);
      return;
    }
    const meta = await this.call(`${FILES_URL}?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [parent] }),
    });
    if (!meta.ok) throw new Error(`Hindi magawa ang Drive file '${name}' (${meta.status}).`);
    const { id } = (await meta.json()) as { id: string };
    const put = await this.call(`${UPLOAD_URL}/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
    });
    if (!put.ok) throw new Error(`Nabigo ang Drive upload (${put.status}).`);
  }

  async list(prefix: string): Promise<string[]> {
    const base = safeRel(prefix).replace(/\/+$/, '');
    const parent = await this.folderId(base);
    const res = await this.call(
      `${FILES_URL}?q=${encodeURIComponent(`'${parent}' in parents and trashed=false`)}&fields=files(name,mimeType)&spaces=drive`,
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { files?: { name: string; mimeType?: string }[] };
    return (json.files ?? [])
      .filter(f => f.mimeType !== FOLDER_MIME)
      .map(f => `${base}/${f.name}`)
      .sort();
  }

  async remove(rel: string): Promise<void> {
    const norm = safeRel(rel);
    const parent = await this.folderId(path.posix.dirname(norm));
    const id = await this.findFile(path.posix.basename(norm), parent);
    if (id) await this.call(`${FILES_URL}/${id}`, { method: 'DELETE' });
  }
}

/**
 * Pick the Drive store from the environment, or null when neither a mount nor a
 * folder id is configured. A null result is what makes the colab backend report
 * an honest "Drive is not configured" instead of hanging.
 */
export function driveStoreFromEnv(): DriveStore | null {
  const folderId = process.env.COLAB_DRIVE_FOLDER_ID?.trim();
  if (folderId) {
    // Imported lazily so the fs path never needs the OAuth machinery.
    const token = async () => {
      const { accessToken } = await import('./gdrive.ts');
      return accessToken();
    };
    return new GoogleDriveStore(folderId, token);
  }
  const root = process.env.COLAB_DRIVE_ROOT?.trim();
  if (root) return new FsDriveStore(root);
  return null;
}
