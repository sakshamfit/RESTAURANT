# Backup & disaster recovery

Everything in this file is about one question: **if this computer is lost, stolen,
burned or simply dies, can the restaurant open tomorrow with its data intact?**

Two rules shape the whole design:

1. **A backup is never called a backup until it has been verified.** The app writes
   the file, closes it, re-opens it, decompresses, decrypts, re-checksums and
   re-counts the rows, and only then records it. "Backup Complete" in the UI means a
   verified file exists on disk — nothing less.
2. **Customer cloud = customer storage.** Verified copies go into *the restaurant's
   own* Google Drive / OneDrive / Dropbox account, using *the restaurant's own*
   OAuth client. There is no backup service of ours, no bucket of ours, no database
   of ours holding a copy, and nothing for us to pay for or be liable for. If this
   repository were taken offline tomorrow, existing backups would remain readable by
   the customer.

Backups are **additive**: the existing PostgreSQL store (or `data/restaurant.json`
fallback) stays exactly as it is. The backup engine reads a snapshot; it is never in
the request path of orders, billing or printing.

---

## 1. What one backup contains, and how it is built

```
SNAPSHOT → VALIDATE → SERIALIZE → COMPRESS → ENCRYPT → SHA-256
        → WRITE TEMP → VERIFY → ATOMIC RENAME → LOCAL VERIFIED
        → CLOUD UPLOAD → REMOTE VERIFY → PROTECTED
```

| Stage | What happens | If it fails |
| --- | --- | --- |
| Snapshot | One read-consistent read of the categories / tables / products / orders / feedbacks / waiter-calls collections from the live store | Reported, nothing written |
| Validate | Shape check (`validateSnapshotShape`) + row counts, before anything is packed | Aborts with an owner-readable message |
| Serialize | Canonical JSON, plus a **plaintext header** (format version, KDF params, IV, sizes, row counts) | — |
| Compress | `gzip` level 9 | — |
| Encrypt | AES-256-GCM with a per-installation data key (only when a backup password is set) | — |
| SHA-256 | Hash of the stored blob **and** of the payload JSON, recorded in the header | — |
| Write temp | `…/.tmp-<pid>-<rand>.rdbak`, `0600`, `fsync`, directory `fsync` | Partial file deleted |
| Verify | Re-open the temp file, parse it, decrypt, compare counts and both hashes | The unverified file is deleted, never renamed |
| Atomic rename | `rename()` into a free name inside the class folder | Existing files untouched |
| Cloud upload | Resumable, chunked, into the customer's folder | Kept locally, marked *pending*, retried with backoff |
| Remote verify | Re-download / metadata hash comparison inside the customer's folder | Only then: *Protected* |

The container is `RDBAK1`: magic + version + length-prefixed JSON header + payload
blob. The whole-file SHA-256 lives in the local manifest (`manifest.json`), which is
a rebuildable cache: delete it and the app re-scans the folder and finds everything
again.

### File names and folders

Cloud layout, inside the customer's own storage:

```
Restaurant Backup/
└── Restaurant-rst-1a2b3c4d5e6f7a8b/     ← immutable installation id
    ├── daily/    restaurant-2026-05-01-023000.rdbak
    ├── weekly/   restaurant-2026-04-27-023012.rdbak
    ├── monthly/  restaurant-2026-04-01-023004.rdbak
    └── manual/   restaurant-2026-05-04-211145.rdbak
```

The same four subfolders exist locally, under the OS application-data folder:

| OS | Local backup root |
| --- | --- |
| Windows | `%APPDATA%\NEXORAOSP Restaurant\backups` |
| macOS | `~/Library/Application Support/NEXORAOSP Restaurant/backups` |
| Linux | `$XDG_DATA_HOME`/`~/.local/share` `+ /NEXORAOSP Restaurant/backups` |
| Any | `BACKUP_DIR` env var overrides it; Admin → Backup & Recovery → Automatic overrides that |

Never the install folder: updates replace it and uninstallers delete it. A relative
`record.file` (`"daily/restaurant-…​.rdbak"`) is always resolved through a helper that
rejects absolute paths, `..`, drive letters and UNC paths — the manifest and any
imported file are treated as untrusted input.

Which folder a file lands in is decided once, at creation: the first automatic backup
of an ISO month goes to `monthly/`, else the first of the ISO week to `weekly/`, else
`daily/`; manual, safety and imported copies go to `manual/`. The cloud subfolder is
always taken from the record's class, never from the trigger.

---

## 2. Schedule

* One automatic run per day at the configured local time (default **02:30**).
* If the machine was off at that time, a **catch-up** run happens at the next start
  (at most one per day), so a shop that closes at midnight and shuts the PC down still
  gets its backup.
* Cloud retries run on their own timer every 15 minutes and only when a provider is
  connected.
* A scheduled run waits for the local backup, then queues the cloud copy; a manual
  "Back up now" from the UI returns as soon as the local file is verified and lets the
  upload finish in the background.
* Timers are `unref()`'d and every failure inside them is recorded, never thrown:
  **a backup failure can never stop or slow the point of sale.**
* The serverless (Vercel) entry point deliberately does *not* start the scheduler — a
  function invocation must not leave timers behind. Hosted deployments get manual
  backups plus their own cloud copies.

## 3. Retention

Defaults, editable in Admin → Backup & Recovery → Automatic:

| Class | Kept |
| --- | --- |
| `daily` | 14 newest |
| `weekly` | 12 newest |
| `monthly` | 12 newest |
| `manual` | until the owner deletes them |

Never deleted, no matter the settings: the newest verified backup, anything currently
uploading, a manual / safety / imported copy, the safety copy of a restore, and the
last remaining recovery point. Pruning a local file **never** deletes its cloud copy:
the off-site copies age out on their own schedule or by the owner's hand.

## 4. States the owner sees

| State | Meaning (icon + words in the UI, never colour alone) |
| --- | --- |
| **Protected** | The newest backup is verified here *and* confirmed inside the customer's cloud folder. |
| **Verified locally** / **Cloud disconnected** | A verified file exists; nothing is off-site yet. |
| **Backup pending** | Verified locally, waiting for the cloud (offline, provider hiccup). The next retry is shown, and "Send now" is one click. |
| **Uploading** | Live progress (`62% — resumed where it stopped`). |
| **Attention required** | Access expired / needs reconnect / no verified file exists / an encryption gate. Phrased for an owner, with the button that fixes it — e.g. *"Google Drive access expired. Reconnect Google Drive to resume automatic backups."* + **Reconnect**. |
| **Backup failed** | A non-retryable error (disk full, permission denied, provider refusal). The local file and the app keep working; the reason is stated in words. |

Internal codes (`401`, `insufficient_space`, `ETIMEDOUT`, stack traces) are translated
by the API layer into those sentences; a raw code never reaches the screen.

---

## 5. Security

* **Encryption.** A random 32-byte data key (DEK) per installation encrypts every
  backup with AES-256-GCM. The owner's password never encrypts files directly: it
  derives a KEK with `scrypt(N=32768, r=8, p=1)` and unwraps the DEK. Changing the
  backup password therefore re-wraps the *same* DEK — old files still open.
  The header's own fields are the GCM additional-authenticated-data, so a tampered
  size or checksum fails authentication rather than decrypting into garbage.
* **Cloud uploads require encryption.** An unencrypted copy of a whole restaurant's
  sales history is never pushed into any third-party storage; the app says so and
  offers to turn the password on.
* **Secrets.** OAuth refresh tokens and the wrapped DEK go to the OS credential store
  (Windows DPAPI, macOS Keychain, `secret-tool`/GNOME Keyring on Linux), written
  `0600`. Where no secure store exists, the fallback file is `0600` and the UI says
  plainly that it is less secure. Client *secrets* are only ever read from the
  environment — never written to `data/`, never logged, never returned by an API.
  `scrubSecrets()` strips password/token fields from the snapshot before it is packed,
  so a backup never contains the admin password hash or the WhatsApp API token.
* **OAuth.** Authorization-code + PKCE (S256), single-use random `state`
  (CSRF + replay protection, expired after 15 minutes, consumed on first read),
  `redirect_uri` validated to be *this app's own* `/api/cloud/callback` on the host the
  owner is using (no open redirect), `access_type=offline`, revocation on disconnect,
  and the code is exchanged once, server-side. No token or code is ever rendered into
  HTML, put in a URL after authorization, or reused.
* **Least privilege.** Google `drive.file` (only files this app created), OneDrive
  `Files.ReadWrite.AppFolder` (the app's own `Restaurant Backup` tree, nothing else in
  the OneDrive), Dropbox app-folder-scoped `files.content.write/read` +
  `account_info.read`.
* **Disconnect and provider changes never delete customer files.** Disconnecting
  revokes access and keeps every cloud copy, with the count of remaining files in the
  confirmation dialog. Switching provider moves the old connection into a retired list
  that stays visible in the history. There is no "also delete my cloud files" option
  anywhere in the API, because one misclick must not destroy the only off-site copy.
* **Restore is untrusted-input territory.** Format version, structure, checksums,
  encryption metadata, size ceilings (256 MB file / 768 MB decoded), a schema version
  from the future, path traversal in `record.file`, and the owning `restaurantId` are
  all checked. A foreign file needs an explicit acknowledgement. Before anything is
  applied the app writes a **safety backup** of the live data; if applying or
  re-validating fails, it rolls back to that safety copy. Order numbers only ever move
  forward, so a restore can never re-issue a bill number.
* **Imported files are never applied.** "Bring onto this computer" verifies and lists
  a file; restoring it is a separate, deliberately confirmed action.

---

## 6. Setting up each provider (one time, ~5 minutes each)

All three use a client **you** own, so the connection belongs to the restaurant and
keeps working even if this project disappeared. Put the identifiers in `.env`
(see `.env.example`) or in the process environment of the service that runs the app,
then restart it. Admin → Backup & Recovery → Cloud Storage will tell you which ones
are configured; an unconfigured provider shows what is missing instead of a dead
button.

The redirect URI for every provider is the app's own address:

```
http://<host-the-app-is-opened-on>:<port>/api/cloud/callback
```

The app does not ask you for this address — it derives it from the URL you have open,
and the **Connect** panel shows the exact address to register (select it to copy). It
must match character for character, so open the admin console at a registered address:
opening the app as `http://192.168.1.42:3000` while only `http://localhost:3000/…` is
registered will be refused by the provider — register both if you use both.

| How it runs | Redirect URI to register |
| --- | --- |
| Desktop app (Electron) | `http://127.0.0.1:38245/api/cloud/callback` — the bundled server holds that port across restarts (that stability is also what keeps printed table QR codes valid); if something else already owns it, it steps through 38246–38250, so registering all six covers every case |
| `npm run dev` / self-hosted node | `http://127.0.0.1:3000/api/cloud/callback`, plus the LAN address if staff/phones reach it that way |
| Hosted (Vercel etc.) | the public origin, e.g. `https://cafe.example.com/api/cloud/callback` |

If the app ever ends up on an unexpected port (every candidate was busy), the panel
still shows the address it needs — add that one, or use **OneDrive's device-code
flow**, which has no redirect URI at all: the app displays a code to type at
`microsoft.com/devicelogin` from any device on any port.

### Google Drive

1. console.cloud.google.com → APIs & Services → enable **Google Drive API** and
   **Google OAuth Access Boundaries API** (optional) — then *OAuth consent screen*:
   External, app name + your e-mail, and add the scope
   `https://www.googleapis.com/auth/drive.file`. Publish (Testing is fine, but tokens
   then expire in 7 days — "Publish app" avoids that).
2. Credentials → *Create credentials* → **OAuth client ID** → application type
   **Desktop app** (it needs no client secret — the app uses PKCE; a Web-application
   client also works, in which case paste the secret too). Add the redirect URI above
   under *Additional redirect URIs*.
3. `.env`: `GOOGLE_CLIENT_ID="…apps.googleusercontent.com"` (and
   `GOOGLE_CLIENT_SECRET=""` for a Desktop-type client).

### OneDrive (personal Microsoft account)

1. entra.microsoft.com → *App registrations* → New registration → any name,
   "Personal Microsoft accounts only".
2. *Authentication* → Add a **Mobile application** platform (that is what gives you
   `http://localhost` style redirects) → tick **Public client/native** and add the
   redirect URI above.
3. *API permissions* → add `Files.ReadWrite.AppFolder`, `offline_access`, `User.Read`
   (delegate). No admin consent needed for personal accounts.
4. *Certificates & secrets*: nothing to create — this is a public client (PKCE).
5. `.env`: `MICROSOFT_CLIENT_ID="<application (client) ID>"`.

OneDrive also offers a **device-code** flow, which is handy when the till machine's
browser is awkward: the app then shows a 8-character code to type at
`microsoft.com/devicelogin` from any phone or laptop.

### Dropbox

1. dropbox.com/developers → *App Console* → *Create app* → **Dropbox API**,
   **App folder** (not "Full Dropbox" — that is what keeps the app inside its own
   `/Apps/…` folder), name it e.g. `Nagori POS Backups`.
2. *Permissions* tab: enable `files.content.write`, `files.content.read`,
   `account_info.read`.
3. *Branding/OAuth* → add the redirect URI above under **OAuth 2 redirect URIs**; note
   the *App key* and *App secret*.
4. `.env`: `DROPBOX_APP_KEY="…"`, `DROPBOX_APP_SECRET="…"`.

> Why app-folder access matters: with an app-folder Dropbox app the software
> physically cannot read anything else in the customer's account, and that limit is
> enforced by Dropbox, not by our promises.

### Connecting from the app

Admin → **Backup & Recovery** → **Cloud Storage** → *Connect …* → the app hands you a
real link (rendered as a plain `<a target="_blank">`, so it works in a browser *and*
in the desktop app, where popups are blocked) → sign in and approve at the provider →
that tab says "Cloud storage connected" and can be closed. The Backup Center notices
by itself within a couple of seconds.

Before the connection is saved, the app writes a probe file into the folder, reads it
back, verifies it and deletes it — so "Connected" means it can really store and
retrieve a file, not merely that a token was minted. It then creates
`Restaurant Backup/Restaurant-<id>/{daily,weekly,monthly,manual}` (reusing existing
folders — reconnecting never creates a duplicate `Restaurant Backup (1)`).

---

## 7. Restoring

**Restore a normal night's backup**

1. Admin → Backup & Recovery → History → *Restore* on the row you want.
2. Read the dialog: it lists exactly which counts will be replaced, and states the
   order of operations.
3. Tick the confirmation, enter the backup password if encryption is on, press
   **Take safety copy and restore**.
4. The app writes a safety backup of the current data into `manual/`, verifies the
   chosen file, swaps the snapshot in, recounts and re-validates. If anything fails it
   restores the safety copy and leaves your data as it was.
5. Order numbers continue from the highest number present; no bill number is reused.

**New computer / after a disaster** (the old machine need not exist)

1. Install and start the app once so its data folder exists.
2. Set the same **backup password** — without it the encrypted copies cannot be
   opened, which is the point of encrypting them.
3. Backup & Recovery → Cloud Storage → connect the account that holds
   `Restaurant Backup/Restaurant-…/`.
4. In *Files in your cloud folder*, press **Bring onto this computer** on the newest
   file. It is downloaded to a temporary file, verified, and listed as a manual
   backup — still not applied.
5. Check the row counts it reports, then **Restore**.

If the cloud account itself is gone, the same steps work from a downloaded or
USB-copied `.rdbak` file via *Bring in a backup file*.

## 8. API surface

All admin endpoints reuse the existing session auth (`Authorization: Bearer …`), and
`/api/cloud/callback` is the one public route, protected by its single-use `state`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/backup/status` | The whole overview in one call (config, location, counts, newest, schedule, cloud state, live uploads). |
| `GET /api/admin/backup/history` | Manifest listing, with local/cloud state per file. |
| `GET/POST /api/admin/backup/config` | Schedule, retention, local folder, encryption on/off. |
| `POST /api/admin/backup/create` · `/upload` · `/restore` · `/import` | The pipeline, a manual cloud sync, a restore, an untrusted-file import. |
| `POST /api/admin/backup/:id/verify` · `/delete` | Re-verify one file; delete a local record (refuses the last recovery point). |
| `GET /api/admin/backup/:id/export` | Streams the `.rdbak` (header-auth, so the UI fetches it and saves a Blob). |
| `POST /api/admin/backup/first-run` | Answers the one-time prompt (`dismiss` / `complete`). |
| `GET /api/admin/cloud/providers` · `/status` | What is available and what state it is in. |
| `POST /api/admin/cloud/:provider/connect` | Returns the real authorize URL (or a device code + URL). |
| `GET /api/cloud/callback` | Where the provider sends the browser; exchanges the code once. |
| `GET /api/admin/cloud/connect-result` | Single-read poll for the outcome of that sign-in. |
| `POST /api/admin/cloud/:provider/callback` · `/disconnect` · `/test` | Paste-a-code fallback, disconnect (keeps files), probe round-trip. |
| `GET /api/admin/cloud/remote` · `POST /remote/import` · `/remote/delete` | The customer folder: list, bring a file down, delete one (guarded). |

## 9. What this does *not* do

* It is **not** a hosted backup service. No S3, no Supabase/Firebase Storage, no
  Cloudinary, no vendor-owned Drive/Dropbox/OneDrive folder, no `customer_backups/`
  bucket, no backup payloads in any database of ours, and no "upload to us" button.
  Mock providers exist only inside the throwaway test harnesses.
* It is not a real-time replica. One run a day (plus manual ones) is the contract;
  a crash can lose the last few hours unless you back up before closing.
* Database-level PITR, WAL archiving and multi-device sync are out of scope; the
  engine is a verified logical snapshot of the app's own data.
* On a hosted/Vercel deployment there is no durable disk: `localDir` is ephemeral
  (`/tmp/restaurant-data/backups`), so the off-site copy in *your own* cloud account
  is the whole backup strategy there.
* Print/layout files and the PostgreSQL schema were not touched. The DB keeps its
  schema; a restore writes back through the same store abstraction.

### Menu images

There is no separate media folder to remember: `store.uploadImage()` keeps a product
image inside the product record (a data URL), so images are part of the snapshot and
travel inside the `.rdbak`. That is also why a whole-database backup stays small — and
why the engine refuses files over 256 MB rather than quietly truncating anything.

## 10. Testing this

Three throwaway harnesses were used while building the feature (they are not part of
the shipped tree):

* the engine: create / verify / corrupt / atomic write / disk-full / restart
  recovery / retention / class folders;
* the HTTP layer: auth guards, every route, restore matrix, import of a hostile file;
* the providers: OAuth, account, folder creation and reuse, upload, download, list,
  delete, revoked access, expired token, quota, interrupted-upload resume,
  offline → pending → reconnect → uploaded, and the new-computer restore — all against
  in-process fakes of the three providers' REST APIs.

To check the feature by hand without any cloud account:

```bash
npm run dev
# Admin → Backup & Recovery → Back up now
ls ~/.local/share/"NEXORAOSP Restaurant"/backups/*      # verified .rdbak files
python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" \
  ~/.local/share/"NEXORAOSP Restaurant"/backups/manual/*.rdbak   # compare with the manifest
```
