import { Notice, Plugin, TFile, debounce } from "obsidian";
import { GoogleAuth, StoredAuth } from "./googleAuth";
import { DriveClient } from "./driveClient";
import { SyncEngine, SyncStateMap } from "./syncEngine";
import { DEFAULT_SETTINGS, GDriveSyncSettingTab, PluginSettings } from "./settingsTab";

interface PluginData {
  settings: PluginSettings;
  auth: StoredAuth | null;
  syncState: SyncStateMap;
}

const DEFAULT_DATA: PluginData = {
  settings: DEFAULT_SETTINGS,
  auth: null,
  syncState: {},
};

export default class GDriveSyncPlugin extends Plugin {
  settings!: PluginSettings;
  auth!: GoogleAuth;
  drive!: DriveClient;
  engine!: SyncEngine;

  private data!: PluginData;
  private statusBarEl!: HTMLElement;
  private autoSyncTimer: number | null = null;
  private syncInProgress = false;

  async onload() {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
    this.settings = this.data.settings;
    if (!this.settings.vaultId) {
      this.settings.vaultId = crypto.randomUUID();
      await this.saveSettings();
    }

    this.auth = new GoogleAuth(
      this.settings.clientId,
      this.settings.clientSecret,
      () => this.data.auth,
      async (auth) => {
        this.data.auth = auth;
        await this.saveData(this.data);
      }
    );
    this.drive = new DriveClient(this.auth);

    this.rebuildEngine();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText("Drive: idle");

    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => {
      this.runSync();
    });

    this.addCommand({
      id: "gdrive-sync-now",
      name: "Sync now",
      callback: () => this.runSync(),
    });

    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

    const debouncedSync = debounce(() => this.runSync(), 8000, true);
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (this.settings.syncOnSave && f instanceof TFile) debouncedSync();
      })
    );

    this.restartAutoSync();
  }

  onunload() {
    if (this.autoSyncTimer) window.clearInterval(this.autoSyncTimer);
  }

  rebuildEngine() {
    const excludeRegexes = this.settings.excludePatterns
      .map((p) => {
        try {
          return new RegExp(p);
        } catch {
          return null;
        }
      })
      .filter((r): r is RegExp => r !== null);

    this.engine = new SyncEngine(
      this.app,
      this.drive,
      () => this.data.syncState,
      async (s) => {
        this.data.syncState = s;
        await this.saveData(this.data);
      },
      this.settings.vaultId,
      this.app.vault.getName(),
      excludeRegexes
    );
  }

  async saveSettings() {
    this.data.settings = this.settings;
    await this.saveData(this.data);
    this.rebuildEngine();
  }

  restartAutoSync() {
    if (this.autoSyncTimer) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (this.settings.autoSyncMinutes > 0) {
      this.autoSyncTimer = window.setInterval(
        () => this.runSync(),
        this.settings.autoSyncMinutes * 60 * 1000
      );
      this.registerInterval(this.autoSyncTimer);
    }
  }

  async runSync() {
    if (this.syncInProgress) return;
    if (!this.auth.isSignedIn()) {
      new Notice("Sign in to Google Drive first (plugin settings).");
      return;
    }

    this.syncInProgress = true;
    this.statusBarEl.setText("Drive: syncing…");
    try {
      const summary = await this.engine.syncAll();
      const n = summary.events.filter((e) => e.action !== "skipped").length;
      this.statusBarEl.setText(
        summary.conflicts.length > 0
          ? `Drive: ${summary.conflicts.length} conflict(s)`
          : `Drive: synced (${n})`
      );
      if (summary.conflicts.length > 0) {
        new Notice(
          `Sync finished with ${summary.conflicts.length} conflict(s):\n` +
            summary.conflicts.slice(0, 5).join("\n"),
          10000
        );
      }
    } catch (e) {
      this.statusBarEl.setText("Drive: sync failed");
      new Notice(`Sync failed: ${(e as Error).message}`);
    } finally {
      this.syncInProgress = false;
    }
  }
}
