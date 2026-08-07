import { requestUrl } from "obsidian";

/**
 * Google OAuth 2.0 Device Authorization flow.
 * https://developers.google.com/identity/protocols/oauth2/limited-input-device
 *
 * Why device flow instead of a redirect-URI flow:
 * - Works identically on desktop and Android/iOS — no loopback HTTP server,
 *   no custom URL scheme registration, no in-app browser embedding.
 * - No third-party relay server is needed to keep a client secret hidden,
 *   because you create your OWN "TV and Limited Input" OAuth client in your
 *   OWN Google Cloud project. That client type's secret is handled the same
 *   way official device-flow apps do it — see README for setup steps.
 */

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

export interface StoredAuth {
  refresh_token: string;
  access_token: string;
  expires_at: number; // epoch ms
}

export class GoogleAuth {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private getStored: () => StoredAuth | null,
    private setStored: (auth: StoredAuth | null) => Promise<void>
  ) {}

  /** Step 1: kick off device flow, returns the code to show the user. */
  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const res = await requestUrl({
      url: DEVICE_CODE_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        client_id: this.clientId,
        scope: SCOPE,
      }).toString(),
    });
    return res.json;
  }

  /**
   * Step 2: poll until the user approves (or it expires/errors).
   * Call this right after requestDeviceCode(); it resolves once authorized.
   */
  async pollForToken(
    device: DeviceCodeResponse,
    onTick?: () => void
  ): Promise<StoredAuth> {
    const deadline = Date.now() + device.expires_in * 1000;
    let intervalMs = Math.max(device.interval, 5) * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      onTick?.();

      const res = await requestUrl({
        url: TOKEN_URL,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        throw: false,
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
      });

      if (res.status === 200) {
        const token: TokenResponse = res.json;
        const auth: StoredAuth = {
          refresh_token: token.refresh_token ?? this.getStored()?.refresh_token ?? "",
          access_token: token.access_token,
          expires_at: Date.now() + token.expires_in * 1000 - 60_000,
        };
        await this.setStored(auth);
        return auth;
      }

      const err = res.json?.error;
      if (err === "authorization_pending") continue;
      if (err === "slow_down") {
        intervalMs += 5000;
        continue;
      }
      throw new Error(`Google auth failed: ${err ?? res.status}`);
    }
    throw new Error("Device code expired before authorization completed.");
  }

  /** Returns a valid access token, refreshing it first if needed. */
  async getAccessToken(): Promise<string> {
    const stored = this.getStored();
    if (!stored) throw new Error("Not signed in to Google Drive.");

    if (Date.now() < stored.expires_at) {
      return stored.access_token;
    }

    const res = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      throw: false,
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: stored.refresh_token,
        grant_type: "refresh_token",
      }).toString(),
    });

    if (res.status !== 200) {
      throw new Error(
        "Google Drive token refresh failed — you may need to sign in again."
      );
    }

    const token: TokenResponse = res.json;
    const refreshed: StoredAuth = {
      refresh_token: stored.refresh_token,
      access_token: token.access_token,
      expires_at: Date.now() + token.expires_in * 1000 - 60_000,
    };
    await this.setStored(refreshed);
    return refreshed.access_token;
  }

  isSignedIn(): boolean {
    return this.getStored() !== null;
  }

  async signOut(): Promise<void> {
    await this.setStored(null);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
