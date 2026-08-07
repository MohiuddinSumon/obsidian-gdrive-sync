# Google Drive Sync (Custom)

A self-owned Obsidian sync plugin for Google Drive. No third-party relay server
sees your tokens — auth goes straight from your device to Google, using an
OAuth client you create yourself.

## Why this exists

- **Remotely Save**: Google Drive is now a paid PRO feature.
- **RichardX366/Obsidian-Google-Drive**: works, but routes your auth through
  a third-party server (`ogd.richardxiong.com`), and hasn't been updated
  since Dec 2024.
- This plugin: direct to Google only, real 3-way conflict resolution instead
  of blind "local wins" or "newer wins", and works the same way on desktop
  and Android via OAuth **device flow** (no redirect URI, no custom URL
  scheme, no in-app browser).

## One-time setup: Google Cloud Console

You only do this once. It creates *your own* OAuth client — this plugin's
code never sees your Google password, and no server but Google's ever sees
your tokens.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   create a new project (or reuse one).
2. **APIs & Services → Library** → search "Google Drive API" → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (unless you have a Workspace account, then
     Internal is fine).
   - Fill in app name (e.g. "My Obsidian Sync"), your email for support and
     developer contact.
   - Scopes: add `.../auth/drive.file` (lets the app see only files/folders
     it creates — not your whole Drive).
   - Test users: add your own Google account email (required while the app
     is in "Testing" publishing status — that's fine for personal use,
     no need to submit for verification).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **TV and Limited Input devices**.
   - Name it anything.
   - Copy the **Client ID** and **Client Secret** shown after creation.
5. Paste both into the plugin's settings tab in Obsidian.

The "Client Secret" here isn't a real secret in the traditional sense —
it's how Google's device-flow client type works, same mechanism used by
apps on smart TVs. It's used only in direct calls from your device to
`oauth2.googleapis.com`.

## Installing the plugin

### Desktop

1. Build it (or use the prebuilt `main.js` if you got this as a release):
   ```
   npm install
   npm run build
   ```
2. Copy `main.js`, `manifest.json`, `styles.css` into:
   `<your vault>/.obsidian/plugins/gdrive-sync-custom/`
3. Reload Obsidian, enable the plugin in **Settings → Community plugins**.

### Android (and desktop, more conveniently)

Since this isn't published to the official community plugin store, use
**[BRAT](https://github.com/TfTHacker/obsidian42-brat)** (Beta Reviewers
Auto-update Tester) — it installs and auto-updates plugins straight from a
GitHub repo, and works identically on desktop and Android:

1. Push this plugin's code to your own GitHub repo (public or private).
2. Install the **BRAT** plugin from the community plugin store (available
   on both desktop and Android).
3. In BRAT's settings, **Add Beta Plugin**, paste your repo URL.
4. BRAT pulls `main.js`/`manifest.json`/`styles.css` and installs it like
   any other plugin — no manual file copying, no Android file-manager
   permission wrangling.
5. Enable "Google Drive Sync (Custom)" in Community plugins.

## Publishing a release (for BRAT)

BRAT installs from **GitHub releases**, not just from whatever's on a
branch — it looks at your repo's releases for a tag and, on that release,
downloads `main.js`, `manifest.json`, and `styles.css` as individual
attached files (not the "Source code" zip). If any of that's missing or
the tag doesn't line up with `manifest.json`, BRAT can't find or install
the update.

### Automated (recommended): `.github/workflows/release.yml`

Cut a release on demand, whenever you want, without doing any of the
version-bump/build/tag/attach steps by hand:

1. Go to this repo's **Actions** tab → **Release** workflow → **Run
   workflow**.
2. Optionally type a version (e.g. `0.1.3`, no `v` prefix). Leave it blank
   to release whatever version is currently in `manifest.json`.
3. Run it. The workflow bumps `manifest.json`/`package.json` (if you gave
   a version), builds `main.js`, commits, tags the commit with that
   version, and publishes a GitHub release with `main.js`, `manifest.json`,
   and `styles.css` attached as release assets — everything BRAT needs.

Existing BRAT installs pick up the update automatically on their next
check; new installs follow the **Add Beta Plugin** steps above.

Alternatively, push a version tag yourself after bumping
`manifest.json` locally (`git tag 0.1.3 && git push origin 0.1.3`) — the
same workflow builds and publishes the release for that tag, it just
skips the version-bump/commit step since you already did it.

### Manual (if you'd rather not use Actions)

1. **Bump the version** in both `manifest.json` and `package.json` (keep
   them identical), e.g. `0.1.2` → `0.1.3`. Semantic versioning, no `v`
   prefix.
2. **Build** the plugin so `main.js` is up to date:
   ```
   npm install
   npm run build
   ```
3. **Commit** the version bump and the rebuilt `main.js`, then push.
4. **Tag the commit with the exact version string** from `manifest.json`
   (again, no `v` prefix — BRAT matches the tag name against
   `manifest.json`'s `version` field):
   ```
   git tag 0.1.3
   git push origin 0.1.3
   ```
5. **Create the GitHub release** from that tag (GitHub UI: Releases →
   Draft a new release → choose the tag; or `gh release create 0.1.3`).
6. **Attach three files as binary release assets** — drag them into the
   release's "Attach binaries" area (or pass them to `gh release create`):
   - `main.js`
   - `manifest.json`
   - `styles.css`

   These must be uploaded as release assets, not just be present in the
   repo — BRAT fetches them from the release, not from the branch.
7. Publish the release.

## First sync

1. Open plugin settings, enter your Client ID / Secret, click **Sign in**.
2. You'll see a code and a URL (`google.com/device`). Open that URL on
   *any* device, enter the code, approve.
3. The plugin polls automatically and signs in once you approve — no
   redirect needed back to Obsidian.
4. Click the sync ribbon icon (or run **Sync now** from the command
   palette) to do your first sync.
5. Repeat sign-in on your second device — as long as the vault name
   matches, it'll find and sync to the same Drive folder.

## How conflict resolution works

Each file's sync state tracks three things: the local content hash, the
remote content's checksum, and (for text files) the last-synced text as a
merge base — the same idea `git merge` uses.

- **Only one side changed** → straightforward upload/download.
- **Both sides changed, non-overlapping edits** (e.g. you edited the top of
  a note, another device edited the bottom) → merged automatically, no
  action needed.
- **Both sides changed the same lines** → merged file gets git-style
  markers:
  ```
  <<<<<<< local
  your version of this line
  =======
  the other device's version
  >>>>>>> remote
  ```
  You resolve it like a git conflict — delete the markers, keep what you
  want. The plugin flags these in a notice and the status bar.
- **Binary files, or text files over 500KB** → no line merge attempted;
  both versions are kept (`file (remote copy).ext`) so nothing is silently
  lost.
- **Deleted on one side, unchanged on the other** → deletion propagates.
- **Deleted on one side, changed on the other** → currently resolved by
  keeping the changed version (deletion doesn't win over an edit) — worth
  watching closely in testing.

## Known limitations / what still needs real-device testing

This was built and type-checked/bundled successfully, but **not yet run
inside actual Obsidian on desktop or Android** — that's the next step, and
some things are likely to need adjustment once you do:

- The 3-way line-merge (`diff3.ts`) is a from-scratch LCS-based
  implementation, not a battle-tested library — test it on real conflicting
  edits before trusting it on notes you care about.
- Rename detection isn't implemented — renaming a file looks like a
  delete + create, which means a rename will currently propagate as
  "delete the old path, create the new one" rather than a clean rename.
- No manual conflict-resolution UI yet — you resolve `<<<<<<<` markers by
  hand in the note.
- Large vaults: the full recursive Drive listing on every sync is simple
  but not the most efficient approach; fine for typical note counts, would
  want the Drive Changes API for very large vaults.
- **Back up your vault before your first real sync**, same advice every
  sync plugin gives.

## Architecture

- `src/googleAuth.ts` — OAuth device flow: request code, poll for token,
  refresh access tokens.
- `src/driveClient.ts` — thin Drive API v3 wrapper: find/create the tagged
  vault-root folder, mirror nested folders, list/upload/download/delete.
- `src/diff3.ts` — line-based three-way merge (LCS diff base→local and
  base→remote, then combine).
- `src/syncEngine.ts` — reconciles local vault state vs. remote vs.
  last-synced state per file, decides upload/download/merge/conflict.
- `src/settingsTab.ts` — settings UI, including the device-flow sign-in.
- `src/main.ts` — plugin lifecycle, commands, status bar, auto-sync timer.
