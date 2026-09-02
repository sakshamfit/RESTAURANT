# Desktop releases — auto-update pipeline

The desktop app ships its own update channel. New installers are
published as GitHub Releases; the app checks on launch and every 4
hours, then prompts the admin to restart.

## One-time repo setup

1. Make sure the GitHub repo `sakshamfit/RESTAURANT` exists and is
   private (or public, your call). The `build.publish` block in
   `desktop/package.json` already points at it.
2. Create a GitHub personal access token with `repo` scope. Save it
   as `GH_TOKEN` in the repo's **Settings → Secrets and variables →
   Actions**.

## Cutting a release (automated — recommended)

`.github/workflows/desktop-release.yml` builds Windows + Linux + macOS
installers with the license gate baked in and attaches them (plus the
`latest*.yml` update metadata) to a GitHub Release:

1. Bump the version: `package.json` (`version`) and `desktop/package.json`
   (keep them in lock-step; `scripts/build-desktop.mjs` syncs the latter
   from the root).
2. (Optional) Set the repo **Variable** `LICENSE_API_BASE` to your
   license server URL (Settings → Secrets and variables → Actions). It
   defaults to `https://license.nexoraosp.com`. No secrets are needed:
   the license public key is committed at `license-keys/public.pem`.
3. Push a tag: `git tag v1.0.1 && git push origin v1.0.1` — or run the
   workflow manually from the Actions tab (it accepts a version + notes).

The release is created as a **prerelease**; flip it to a full Release in
the GitHub UI once you've smoke-tested one install.

## Cutting a release (manual)

```bash
# 1. Bump the version in package.json and desktop/package.json (use semver).
#    Patch bump: 1.0.0 → 1.0.1
#    Minor bump: 1.0.0 → 1.1.0
#    Major bump: 1.0.0 → 2.0.0

# 2. Set the license settings, then build for the target platform.
#    (The RSA public key is read automatically from license-keys/public.pem.)
export LICENSE_REQUIRED=true
export LICENSE_API_BASE=https://license.yourcompany.com
export LICENSE_ALLOW_SELF_ISSUE=false
export LICENSE_TRIAL_DAYS=0
npm run desktop:build -- --win   # Windows NSIS installer + portable zip

# 3. Upload the artifacts from ../release/ to a new GitHub release.
#    Tag must match the version (e.g. v1.0.1).
gh release create v1.0.1 ../release/*.exe ../release/*.zip \
  ../release/latest.yml \
  --title "v1.0.1" --notes "Fixes and improvements."

# electron-updater scans the release's assets for files matching
# nexoraosp-restaurant-{version}-{os}-{arch}.{ext}, so the file
# naming pattern in desktop/package.json is important.
```

The first release you publish should already match the version in
`desktop/package.json` (and `package.json`). Otherwise the auto-updater
will offer "downgrade" to existing users (and silently fail on Windows).

## Verifying the channel

After publishing v1.0.1, install v1.0.0 on a test machine, then
either:

- Wait 5 seconds after launch and watch the dashboard banner.
- Click **Console → Check for updates** (or
  **Admin → Settings → App updates → Check for updates**).

Both paths call `bridge.checkForUpdates()` which routes to
`autoUpdater.checkForUpdates()` in the main process. If a newer
release is on GitHub, a dialog will show the release notes and a
"Download and install" button.

## Local dev

The auto-update check uses the public GitHub Releases API, so it
works without any local server. In dev (`npm start` from `desktop/`)
the build is *not* code-signed, so the auto-updater might warn on
macOS / Windows. That warning is fine — the update itself will still
go through.

To test the UI without actually publishing:

```bash
# 1. In desktop/main.cjs, comment out the early-return in
#    checkForUpdatesInteractive() and force-spawn a fake update
#    result. Or just open Console → Check for updates — the dialog
#    will say "you're on the latest version" if no release is up.
```

## What about the web build?

The web build always shows the latest deployed version. There is
nothing to check. The bridge methods (`getUpdateState`,
`checkForUpdates`) are absent on the web, so the dashboard banner
and the Admin Settings → App updates card simply don't render.
