import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type GDriveSyncPlugin from "./main";

export interface PluginSettings {
  clientId: string;
  clientSecret: string;
  vaultId: string; // random, generated once, tags the Drive folder for this vault
  autoSyncMinutes: number; // 0 = disabled
  syncOnSave: boolean;
  excludePatterns: string[]; // regex strings, relative-path matched
}

export const DEFAULT_SETTINGS: PluginSettings = {
  clientId: "",
  clientSecret: "",
  vaultId: "",
  autoSyncMinutes: 10,
  syncOnSave: false,
  excludePatterns: ["^\\.obsidian/", "^\\.trash/"],
};

export class GDriveSyncSettingTab extends PluginSettingTab {
  private unsubscribe: (() => void) | null = null;
  private authStatusEl: HTMLElement | null = null;

  constructor(app: App, private plugin: GDriveSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Google Drive Sync" });

    containerEl.createEl("p", {
      text:
        "Uses your own Google Cloud OAuth client — no third-party relay server sees your tokens. " +
        "See the plugin README for the one-time Google Cloud Console setup.",
    });

    new Setting(containerEl)
      .setName("OAuth Client ID")
      .setDesc("From your Google Cloud Console 'TV and Limited Input' OAuth client.")
      .addText((t) =>
        t
          .setPlaceholder("xxxx.apps.googleusercontent.com")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (v) => {
            this.plugin.settings.clientId = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OAuth Client Secret")
      .setDesc("Also from the same OAuth client.")
      .addText((t) => {
        t.inputEl.type = "password";
        t
          .setPlaceholder("GOCSPX-...")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (v) => {
            this.plugin.settings.clientSecret = v.trim();
            await this.plugin.saveSettings();
          });
      });

    this.authStatusEl = containerEl.createDiv();
    this.renderAuthStatus();

    // Keep this panel in sync even if sign-in finishes in the background
    // (e.g. it resumed automatically after an app reload) rather than
    // from a click made on this exact open instance of the tab.
    this.unsubscribe = this.plugin.onAuthStateChanged(() => this.renderAuthStatus());

    new Setting(containerEl)
      .setName("Auto-sync interval (minutes)")
      .setDesc("0 disables automatic syncing; you can still sync manually.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.autoSyncMinutes))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.autoSyncMinutes = Number.isFinite(n) ? n : 0;
            await this.plugin.saveSettings();
            this.plugin.restartAutoSync();
          })
      );

    new Setting(containerEl)
      .setName("Sync on save")
      .setDesc("Trigger a sync shortly after you save a file (debounced).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnSave).onChange(async (v) => {
          this.plugin.settings.syncOnSave = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc("One regex per line, matched against vault-relative paths.")
      .addTextArea((t) =>
        t
          .setValue(this.plugin.settings.excludePatterns.join("\n"))
          .onChange(async (v) => {
            this.plugin.settings.excludePatterns = v
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );
  }

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private renderAuthStatus() {
    const el = this.authStatusEl;
    if (!el) return;
    el.empty();

    const signedIn = this.plugin.auth.isSignedIn();
    const pending = this.plugin.getPendingDevice();

    if (pending) {
      const box = el.createDiv({ cls: "gdrive-sync-device-code" });
      box.createEl("p", {
        text: `Go to ${pending.verification_url} and enter this code:`,
      });

      const codeRow = box.createDiv({ cls: "gdrive-sync-code-row" });
      codeRow.createEl("span", {
        text: pending.user_code,
        cls: "gdrive-sync-code-text",
      });
      const copyBtn = codeRow.createEl("button", {
        text: "Copy",
        cls: "gdrive-sync-copy-btn",
      });
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(pending.user_code);
          new Notice("Code copied.");
        } catch {
          new Notice(`Code: ${pending.user_code}`, 10000);
        }
      };

      box.createEl("p", {
        text: "This keeps working even if you close this settings tab or switch apps.",
        cls: "setting-item-description",
      });
      new Setting(el).addButton((b) =>
        b.setButtonText("Start over with a new code").onClick(async () => {
          await this.beginSignIn();
        })
      );
      return;
    }

    new Setting(el)
      .setName("Google account")
      .setDesc(signedIn ? "Signed in." : "Not signed in.")
      .addButton((b) =>
        b
          .setButtonText(signedIn ? "Sign out" : "Sign in")
          .setCta()
          .onClick(async () => {
            if (signedIn) {
              await this.plugin.auth.signOut();
              new Notice("Signed out of Google Drive.");
              this.renderAuthStatus();
              return;
            }
            if (!this.plugin.settings.clientId || !this.plugin.settings.clientSecret) {
              new Notice("Enter your OAuth Client ID and Secret first.");
              return;
            }
            await this.beginSignIn();
          })
      );
  }

  private async beginSignIn() {
    try {
      await this.plugin.beginSignIn();
      // renderAuthStatus() will also be triggered via onAuthStateChanged,
      // but call it immediately too so the code shows up without delay.
      this.renderAuthStatus();
    } catch (e) {
      new Notice(`Sign-in failed: ${(e as Error).message}`);
    }
  }
}
