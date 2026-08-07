import { App, TFile, TFolder, normalizePath } from "obsidian";
import { DriveClient, RemoteEntry } from "./driveClient";
import { merge3 } from "./diff3";

const TEXT_MERGE_SIZE_CAP = 500 * 1024; // above this, treat as binary (no diff3, keep-both on conflict)
const MERGE_BASE_SIZE_CAP = 500 * 1024; // cap on how much "last synced text" we retain per file

export interface FileSyncState {
  driveFileId: string;
  lastSyncedLocalHash: string;
  lastSyncedRemoteMd5: string;
  lastSyncedText?: string; // merge base, text files only, size-capped
  isBinary: boolean;
}

export type SyncStateMap = Record<string, FileSyncState>; // key: vault-relative path

export interface SyncEvent {
  path: string;
  action:
    | "uploaded"
    | "downloaded"
    | "merged"
    | "conflict-marked"
    | "conflict-duplicated"
    | "deleted-local"
    | "deleted-remote"
    | "skipped";
}

export interface SyncSummary {
  events: SyncEvent[];
  conflicts: string[];
}

export class SyncEngine {
  constructor(
    private app: App,
    private drive: DriveClient,
    private getState: () => SyncStateMap,
    private setState: (s: SyncStateMap) => Promise<void>,
    private vaultId: string,
    private vaultName: string,
    private excludePatterns: RegExp[]
  ) {}

  async syncAll(): Promise<SyncSummary> {
    const rootId = await this.drive.findOrCreateVaultRoot(this.vaultId, this.vaultName);
    const state = { ...this.getState() };
    const summary: SyncSummary = { events: [], conflicts: [] };

    const remoteEntries = (await this.drive.listAll(rootId)).filter(
      (e) => !e.isFolder
    );
    const remoteByPath = new Map(remoteEntries.map((e) => [e.path, e]));

    const localFiles = this.app.vault
      .getFiles()
      .filter((f) => !this.isExcluded(f.path));
    const localByPath = new Map(localFiles.map((f) => [f.path, f]));

    const allPaths = new Set<string>([...localByPath.keys(), ...remoteByPath.keys()]);

    for (const path of allPaths) {
      if (this.isExcluded(path)) continue;
      const local = localByPath.get(path);
      const remote = remoteByPath.get(path);
      const prior = state[path];

      const event = await this.reconcileFile(rootId, path, local, remote, prior, state);
      summary.events.push(event);
      if (event.action === "conflict-marked" || event.action === "conflict-duplicated") {
        summary.conflicts.push(path);
      }
    }

    await this.setState(state);
    return summary;
  }

  private isExcluded(path: string): boolean {
    return this.excludePatterns.some((re) => re.test(path));
  }

  private async reconcileFile(
    rootId: string,
    path: string,
    local: TFile | undefined,
    remote: RemoteEntry | undefined,
    prior: FileSyncState | undefined,
    state: SyncStateMap
  ): Promise<SyncEvent> {
    // Neither side has it (shouldn't happen, allPaths came from one of them) — no-op.
    if (!local && !remote) return { path, action: "skipped" };

    // New on remote only -> download.
    if (!local && remote) {
      if (prior) {
        // Existed before, now locally deleted -> propagate deletion to remote.
        await this.drive.deleteFile(remote.file.id);
        delete state[path];
        return { path, action: "deleted-remote" };
      }
      await this.downloadNew(path, remote, state);
      return { path, action: "downloaded" };
    }

    // New on local only -> upload.
    if (local && !remote) {
      if (prior) {
        // Existed before, now remotely deleted -> propagate deletion to local.
        await this.app.vault.delete(local);
        delete state[path];
        return { path, action: "deleted-local" };
      }
      await this.uploadNew(rootId, path, local, state);
      return { path, action: "uploaded" };
    }

    // Both exist.
    local!;
    remote!;
    const localHash = await this.hashLocal(local!);
    const remoteChanged = !prior || prior.lastSyncedRemoteMd5 !== remote!.file.md5Checksum;
    const localChanged = !prior || prior.lastSyncedLocalHash !== localHash;

    if (!localChanged && !remoteChanged) {
      return { path, action: "skipped" };
    }
    if (localChanged && !remoteChanged) {
      await this.uploadUpdate(rootId, path, local!, remote!, state);
      return { path, action: "uploaded" };
    }
    if (remoteChanged && !localChanged) {
      await this.downloadUpdate(path, remote!, state);
      return { path, action: "downloaded" };
    }

    // Both changed -> real merge for text, keep-both for binary/oversized.
    const isBinary = prior?.isBinary ?? !isProbablyText(path);
    const localBuf = await this.app.vault.readBinary(local!);
    if (isBinary || localBuf.byteLength > TEXT_MERGE_SIZE_CAP) {
      return this.conflictDuplicate(rootId, path, local!, remote!, state);
    }

    const localText = new TextDecoder().decode(localBuf);
    const remoteBuf = await this.drive.downloadContent(remote!.file.id);
    const remoteText = new TextDecoder().decode(remoteBuf);
    const baseText = prior?.lastSyncedText ?? "";

    const { text: mergedText, hasConflicts } = merge3(baseText, localText, remoteText);

    await this.app.vault.modify(local!, mergedText);
    const uploaded = await this.drive.uploadContent(
      rootId,
      path,
      new TextEncoder().encode(mergedText).buffer,
      "text/markdown",
      remote!.file.id
    );

    state[path] = {
      driveFileId: uploaded.id,
      lastSyncedLocalHash: await this.hashText(mergedText),
      lastSyncedRemoteMd5: uploaded.md5Checksum ?? "",
      lastSyncedText:
        mergedText.length <= MERGE_BASE_SIZE_CAP ? mergedText : undefined,
      isBinary: false,
    };

    return { path, action: hasConflicts ? "conflict-marked" : "merged" };
  }

  private async conflictDuplicate(
    rootId: string,
    path: string,
    local: TFile,
    remote: RemoteEntry,
    state: SyncStateMap
  ): Promise<SyncEvent> {
    // Keep local as-is, save remote's version alongside with a suffix, let the user reconcile.
    const dotIdx = path.lastIndexOf(".");
    const conflictPath =
      dotIdx === -1
        ? `${path} (remote copy)`
        : `${path.slice(0, dotIdx)} (remote copy)${path.slice(dotIdx)}`;

    const remoteBuf = await this.drive.downloadContent(remote.file.id);
    await this.app.vault.createBinary(normalizePath(conflictPath), remoteBuf);

    // Push local as the new authoritative remote version.
    const localBuf = await this.app.vault.readBinary(local);
    const uploaded = await this.drive.uploadContent(
      rootId,
      path,
      localBuf,
      guessMime(path),
      remote.file.id
    );

    state[path] = {
      driveFileId: uploaded.id,
      lastSyncedLocalHash: await this.hashLocal(local),
      lastSyncedRemoteMd5: uploaded.md5Checksum ?? "",
      isBinary: true,
    };

    return { path, action: "conflict-duplicated" };
  }

  private async downloadNew(path: string, remote: RemoteEntry, state: SyncStateMap) {
    const buf = await this.drive.downloadContent(remote.file.id);
    await this.ensureLocalFolder(path);
    await this.app.vault.createBinary(normalizePath(path), buf);
    await this.recordSynced(path, remote, buf, state);
  }

  private async downloadUpdate(path: string, remote: RemoteEntry, state: SyncStateMap) {
    const buf = await this.drive.downloadContent(remote.file.id);
    const file = this.app.vault.getAbstractFileByPath(path) as TFile;
    await this.app.vault.modifyBinary(file, buf);
    await this.recordSynced(path, remote, buf, state);
  }

  private async uploadNew(
    rootId: string,
    path: string,
    local: TFile,
    state: SyncStateMap
  ) {
    const buf = await this.app.vault.readBinary(local);
    const uploaded = await this.drive.uploadContent(rootId, path, buf, guessMime(path));
    await this.recordSyncedFromUpload(path, uploaded, buf, state);
  }

  private async uploadUpdate(
    rootId: string,
    path: string,
    local: TFile,
    remote: RemoteEntry,
    state: SyncStateMap
  ) {
    const buf = await this.app.vault.readBinary(local);
    const uploaded = await this.drive.uploadContent(
      rootId,
      path,
      buf,
      guessMime(path),
      remote.file.id
    );
    await this.recordSyncedFromUpload(path, uploaded, buf, state);
  }

  private async recordSynced(
    path: string,
    remote: RemoteEntry,
    buf: ArrayBuffer,
    state: SyncStateMap
  ) {
    const isBinary = !isProbablyText(path);
    state[path] = {
      driveFileId: remote.file.id,
      lastSyncedLocalHash: await this.hashBuf(buf),
      lastSyncedRemoteMd5: remote.file.md5Checksum ?? "",
      lastSyncedText:
        !isBinary && buf.byteLength <= MERGE_BASE_SIZE_CAP
          ? new TextDecoder().decode(buf)
          : undefined,
      isBinary,
    };
  }

  private async recordSyncedFromUpload(
    path: string,
    uploaded: { id: string; md5Checksum?: string },
    buf: ArrayBuffer,
    state: SyncStateMap
  ) {
    const isBinary = !isProbablyText(path);
    state[path] = {
      driveFileId: uploaded.id,
      lastSyncedLocalHash: await this.hashBuf(buf),
      lastSyncedRemoteMd5: uploaded.md5Checksum ?? "",
      lastSyncedText:
        !isBinary && buf.byteLength <= MERGE_BASE_SIZE_CAP
          ? new TextDecoder().decode(buf)
          : undefined,
      isBinary,
    };
  }

  private async ensureLocalFolder(path: string) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (!dir) return;
    const existing = this.app.vault.getAbstractFileByPath(dir);
    if (existing instanceof TFolder) return;
    await this.app.vault.createFolder(normalizePath(dir)).catch(() => {});
  }

  private async hashLocal(file: TFile): Promise<string> {
    const buf = await this.app.vault.readBinary(file);
    return this.hashBuf(buf);
  }

  private async hashText(text: string): Promise<string> {
    return this.hashBuf(new TextEncoder().encode(text).buffer);
  }

  private async hashBuf(buf: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

function isProbablyText(path: string): boolean {
  return /\.(md|txt|json|css|js|ts|canvas)$/i.test(path);
}

function guessMime(path: string): string {
  if (/\.md$/i.test(path)) return "text/markdown";
  if (/\.(png|jpe?g|gif|webp)$/i.test(path)) return "image/*";
  if (/\.pdf$/i.test(path)) return "application/pdf";
  return "application/octet-stream";
}
