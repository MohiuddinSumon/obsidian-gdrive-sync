import { requestUrl } from "obsidian";
import { GoogleAuth } from "./googleAuth";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  modifiedTime: string; // ISO
  md5Checksum?: string; // absent for folders
  size?: string;
  trashed?: boolean;
}

/** A flattened, path-addressed view of everything under the vault's root folder. */
export interface RemoteEntry {
  path: string; // relative to vault root, e.g. "daily/2026-08-07.md"
  file: DriveFile;
  isFolder: boolean;
}

export class DriveClient {
  private folderIdCache = new Map<string, string>(); // relative folder path -> id

  constructor(private auth: GoogleAuth) {}

  private async authHeader(): Promise<Record<string, string>> {
    const token = await this.auth.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  /** Finds the vault's root Drive folder by an appProperties tag, or creates it. */
  async findOrCreateVaultRoot(vaultId: string, vaultName: string): Promise<string> {
    const headers = await this.authHeader();
    const q = encodeURIComponent(
      `appProperties has { key='obsidianVaultId' and value='${vaultId}' } and trashed = false`
    );
    const res = await requestUrl({
      url: `${API}/files?q=${q}&fields=files(id,name)&spaces=drive`,
      headers,
    });
    const found = res.json.files?.[0];
    if (found) return found.id;

    const createRes = await requestUrl({
      url: `${API}/files?fields=id`,
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: vaultName,
        mimeType: FOLDER_MIME,
        appProperties: { obsidianVaultId: vaultId },
      }),
    });
    return createRes.json.id;
  }

  /** Walks (creating as needed) the folder chain for a relative path's directory part. */
  async ensureParentFolder(rootId: string, relativePath: string): Promise<string> {
    const parts = relativePath.split("/").slice(0, -1);
    let parentId = rootId;
    let cacheKey = "";

    for (const part of parts) {
      cacheKey = cacheKey ? `${cacheKey}/${part}` : part;
      const cached = this.folderIdCache.get(cacheKey);
      if (cached) {
        parentId = cached;
        continue;
      }

      const headers = await this.authHeader();
      const q = encodeURIComponent(
        `name = '${escapeQ(part)}' and '${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`
      );
      const res = await requestUrl({
        url: `${API}/files?q=${q}&fields=files(id,name)`,
        headers,
      });
      let id = res.json.files?.[0]?.id;
      if (!id) {
        const createRes = await requestUrl({
          url: `${API}/files?fields=id`,
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: part,
            mimeType: FOLDER_MIME,
            parents: [parentId],
          }),
        });
        id = createRes.json.id;
      }
      this.folderIdCache.set(cacheKey, id);
      parentId = id;
    }
    return parentId;
  }

  /** Recursively lists every file under the vault root, flattened with relative paths. */
  async listAll(rootId: string): Promise<RemoteEntry[]> {
    const results: RemoteEntry[] = [];
    await this.walk(rootId, "", results);
    return results;
  }

  private async walk(folderId: string, prefix: string, out: RemoteEntry[]) {
    const headers = await this.authHeader();
    let pageToken: string | undefined;

    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
      const url =
        `${API}/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,parents,modifiedTime,md5Checksum,size)` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const res = await requestUrl({ url, headers });
      const files: DriveFile[] = res.json.files ?? [];

      for (const f of files) {
        const path = prefix ? `${prefix}/${f.name}` : f.name;
        const isFolder = f.mimeType === FOLDER_MIME;
        out.push({ path, file: f, isFolder });
        if (isFolder) {
          this.folderIdCache.set(path, f.id);
          await this.walk(f.id, path, out);
        }
      }
      pageToken = res.json.nextPageToken;
    } while (pageToken);
  }

  async downloadContent(fileId: string): Promise<ArrayBuffer> {
    const headers = await this.authHeader();
    const res = await requestUrl({
      url: `${API}/files/${fileId}?alt=media`,
      headers,
    });
    return res.arrayBuffer;
  }

  /** Creates a new file, or updates an existing one if existingFileId is given. */
  async uploadContent(
    rootId: string,
    relativePath: string,
    content: ArrayBuffer,
    mimeType: string,
    existingFileId?: string
  ): Promise<DriveFile> {
    const headers = await this.authHeader();
    const name = relativePath.split("/").pop()!;
    const boundary = "gdrivesync" + Math.random().toString(36).slice(2);
    const metadata: Record<string, unknown> = { name, mimeType };
    if (!existingFileId) {
      const parentId = await this.ensureParentFolder(rootId, relativePath);
      metadata.parents = [parentId];
    }

    const body = buildMultipart(boundary, metadata, content, mimeType);
    const method = existingFileId ? "PATCH" : "POST";
    const url = existingFileId
      ? `${UPLOAD_API}/files/${existingFileId}?uploadType=multipart&fields=id,modifiedTime,md5Checksum`
      : `${UPLOAD_API}/files?uploadType=multipart&fields=id,modifiedTime,md5Checksum`;

    const res = await requestUrl({
      url,
      method,
      headers: {
        ...headers,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    return { ...res.json, name, mimeType, parents: [] };
  }

  async deleteFile(fileId: string): Promise<void> {
    const headers = await this.authHeader();
    await requestUrl({
      url: `${API}/files/${fileId}`,
      method: "DELETE",
      headers,
      throw: false,
    });
  }

  async createFolder(rootId: string, relativePath: string): Promise<string> {
    return this.ensureParentFolder(rootId, relativePath + "/_");
  }
}

function escapeQ(s: string): string {
  return s.replace(/'/g, "\\'");
}

function buildMultipart(
  boundary: string,
  metadata: Record<string, unknown>,
  content: ArrayBuffer,
  mimeType: string
): ArrayBuffer {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metadata) +
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);

  const total = head.byteLength + content.byteLength + tail.byteLength;
  const combined = new Uint8Array(total);
  combined.set(head, 0);
  combined.set(new Uint8Array(content), head.byteLength);
  combined.set(tail, head.byteLength + content.byteLength);
  return combined.buffer;
}
