import { Notice, Plugin, TFile, debounce } from "obsidian";
import { DeviceCodeResponse, GoogleAuth, StoredAuth } from "./googleAuth";
import { DriveClient } from "./driveClient";
import { SyncEngine, SyncStateMap } from "./syncEngine";
import { DEFAULT_SETTINGS, GDriveSyncSettingTab, PluginSettings } from "./settingsTab";

interface PendingDevice {
  device_code: string;
  user_code: string;
  verification_url: string;
  interval: number;
  expires_at: number; // epoch ms
}

interface PluginData {
  settings: PluginSettings;
  auth: StoredAuth | null;
  syncState: SyncStateMap;
  pendingDevice: PendingDevice | null;
}

const DEFAULT_DATA: PluginData = {
  settings: DEFAULT_SETTINGS,
  auth: null,
  syncState: {},
  pendingDevice: null,
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
  private signInInFlight = false;
  private authListeners = new Set<() => void>();

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
        this.notifyAuthListeners();
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

    // If a sign-in was started but never finished (e.g. the app was
    // reloaded on Android while you were approving the code in the
    // browser), pick it back up automatically instead of leaving you
    // stuck on the sign-in screen.
    this.resumePendingSignIn();
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

  // --- Sign-in state, shared between the settings tab and app restarts ---

  /** Subscribe to auth/pending-sign-in changes. Returns an unsubscribe fn. */
  onAuthStateChanged(cb: () => void): () => void {
    this.authListeners.add(cb);
    return () => this.authListeners.delete(cb);
  }

  private notifyAuthListeners() {
    this.authListeners.forEach((cb) => cb());
  }

  getPendingDevice(): PendingDevice | null {
    const p = this.data.pendingDevice;
    if (p && p.expires_at < Date.now()) return null;
    return p;
  }

  /** Kicks off a fresh device-flow sign-in. Safe to call from the settings tab. */
  async beginSignIn(): Promise<void> {
    const device = await this.auth.requestDeviceCode();
    const pending: PendingDevice = {
      device_code: device.device_code,
      user_code: device.user_code,
      verification_url: device.verification_url,
      interval: device.interval,
      expires_at: Date.now() + device.expires_in * 1000,
    };
    this.data.pendingDevice = pending;
    await this.saveData(this.data);
    this.notifyAuthListeners();
    this.pollInBackground(device);
  }

  /** Called on every plugin load — resumes an unfinished sign-in, if any. */
  private resumePendingSignIn() {
    const pending = this.getPendingDevice();
    if (!pending) {
      if (this.data.pendingDevice) {
        // It existed but expired while the app was closed — clear it.
        this.data.pendingDevice = null;
        this.saveData(this.data);
      }
      return;
    }
    const remainingSeconds = Math.max(
      Math.floor((pending.expires_at - Date.now()) / 1000),
      1
    );
    this.pollInBackground({
      device_code: pending.device_code,
      user_code: pending.user_code,
      verification_url: pending.verification_url,
      interval: pending.interval,
      expires_in: remainingSeconds,
    });
  }

  private pollInBackground(device: DeviceCodeResponse) {
    if (this.signInInFlight) return;
    this.signInInFlight = true;

    this.auth
      .pollForToken(device)
      .then(async () => {
        this.data.pendingDevice = null;
        await this.saveData(this.data);
        new Notice("Signed in to Google Drive.");
      })
      .catch(async (e) => {
        this.data.pendingDevice = null;
        await this.saveData(this.data);
        new Notice(`Google sign-in did not complete: ${(e as Error).message}`);
      })
      .finally(() => {
        this.signInInFlight = false;
        this.notifyAuthListeners();
      });
  }

  // --- Sync ---

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
