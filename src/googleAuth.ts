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

export type PollOutcome =
  | { status: "ok"; auth: StoredAuth }
  | { status: "pending" }
  | { status: "slow_down" };

/**
 * Turn a raw OAuth device-flow error code into something a user can act on.
 * The most common source of confusion: the browser shows "Success! Device
 * connected" (that only needs client_id and completes on Google's side),
 * but the token exchange that follows also needs client_secret and can
 * still fail — those two facts look identical from the settings screen
 * unless the real error code is surfaced.
 */
function describeDeviceFlowError(code: string | undefined, status: number): string {
  switch (code) {
    case "access_denied":
      return "You denied the request (or a different Google account was used) on Google's page.";
    case "invalid_grant":
    case "expired_token":
      return "The code already expired or was already redeemed — tap 'Start over with a new code'.";
    case "invalid_client":
      return "Google rejected the Client ID/Secret during token exchange — re-check them in settings, then Sign in again (editing them alone isn't enough if a sign-in was already in progress).";
    default:
      return `Google auth failed: ${code ?? status}`;
  }
}

export class GoogleAuth {
  // Lets a caller interrupt an in-progress poll's wait and check right
  // away — used when the app comes back to the foreground after the user
  // finishes in the browser, instead of waiting out a possibly-stale timer.
  private wakeResolvers: Array<() => void> = [];

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

  /** Wakes any pending pollForToken() wait so it checks immediately. */
  wake(): void {
    this.wakeResolvers.splice(0).forEach((resolve) => resolve());
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** A single token-exchange attempt — used both by the background poll
   *  loop and by an on-demand "check now" call. */
  async pollOnce(device: Pick<DeviceCodeResponse, "device_code">): Promise<PollOutcome> {
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
      return { status: "ok", auth };
    }

    const err = res.json?.error;
    if (err === "authorization_pending") return { status: "pending" };
    if (err === "slow_down") return { status: "slow_down" };
    throw new Error(describeDeviceFlowError(err, res.status));
  }

  /**
   * Step 2: poll until the user approves (or it expires/errors).
   * Call this right after requestDeviceCode(); it resolves once authorized.
   * The wait between attempts can be short-circuited via wake().
   */
  async pollForToken(
    device: DeviceCodeResponse,
    onTick?: () => void
  ): Promise<StoredAuth> {
    const deadline = Date.now() + device.expires_in * 1000;
    let intervalMs = Math.max(device.interval, 5) * 1000;

    while (Date.now() < deadline) {
      await this.interruptibleSleep(intervalMs);
      onTick?.();

      const outcome = await this.pollOnce(device);
      if (outcome.status === "ok") return outcome.auth;
      if (outcome.status === "slow_down") intervalMs += 5000;
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

  /** Call after the OAuth Client ID/Secret change in settings, so an
   *  in-progress or future sign-in doesn't use stale credentials. */
  updateCredentials(clientId: string, clientSecret: string): void {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  async signOut(): Promise<void> {
    await this.setStored(null);
  }
}
