# StudyQuest Hosted Server

See [STUDYQUEST-OPERATIONS-GUIDE.md](./STUDYQUEST-OPERATIONS-GUIDE.md) for the
safe operating checklist, save-status meanings, setup, recovery, backups, and
LINE admin procedure. Never add real secrets to either document.

This folder is a Render-ready StudyQuest sync server backed by PostgreSQL.

It is separate from the local laptop sync bridge. The hosted version is the better long-term option when friends do not want to use Tailscale.

## Live App

Open the live app here:

```text
https://studyquest-sync-server.onrender.com/app.html
```

Backup/root link:

```text
https://studyquest-sync-server.onrender.com/
```

Admin-only v13:

```text
https://studyquest-sync-server.onrender.com/v13
```

Current Render service:

```text
studyquest-sync-server
```

Deployment behavior:

- Render shows this web service as `Node Free`.
- `/v13` and `/claudever13.html` require the `admin` account. Other users are redirected to the stable app and never receive the daily v13 file.
- Admin login opens v13 automatically unless `/app.html?stable=1` was requested. v13 always keeps a Stable App fallback button.
- The committed HTML is served directly. Startup no longer rewrites the tested release with patch scripts.
- `/api/v2/state` requires revision lineage. New clients send `baseRevision`, `baseHash`, a retry-safe `mutationId`, and a record-change manifest.
- The server compares record IDs before every write. Missing tasks, notes, files, checklist items, grades, trips, Weekly records, categories, or notebooks require matching user-deletion entries; otherwise the save is rejected as `DESTRUCTIVE_CHANGE_REVIEW_REQUIRED` and both copies remain intact.
- Hosted `POST /api/state` is disabled. Every cloud write must include its known base revision through `/api/v2/state`.
- Every stable-app edit saves first to `studyquest_v3_<username>` and IndexedDB, with a durable offline outbox and rolling device recovery copies. Cloud backup starts after a 500 ms quiet period, and page exit performs a final device save plus a best-effort revision-protected upload.
- Admin v13 uses the same IndexedDB recovery database and durable outbox. If localStorage reaches its quota, edits and approved merges remain recoverable in IndexedDB instead of failing; unknown cloud revisions still require comparison.
- Every unique accepted cloud revision is retained as a compressed immutable `state_versions` record. Accepted, unchanged, conflicted, blocked/rejected, recovered, restored, and oversized attempts are recorded in `state_save_events` without passwords or state contents.
- Admin v13 sends saved edits after a 500 ms quiet period and retries its durable outbox after reopen, reconnect, focus, and visibility changes. Periodic checks remain a fallback; Chrome-versus-local-server, imported, and live differences still require a per-field Smart Merge preview.
- `_syncMeta` records stable IDs, per-field update stamps, deletion tombstones, additive counters, and 90 days or 500 visible change events. Legacy/tied/unverified differences require a manual choice.
- Recovery Center reports sync times, per-field decisions, change history, and saved-state usage. Chrome, Live, and the proposed merge can be exported together before applying.
- Weekly curriculum is stored inside each account's state. New Weekly users choose ICE, BALAC, Industrial Pharmacy, a custom curriculum, or a blank program instead of receiving ICE automatically.
- Existing Weekly semesters, weeks, notes, checks, and edited course lists are migrated additively. `Edit Subjects` remains the per-semester source for that user's course names and weekdays.
- One-time admin pairing codes expire after 10 minutes. Device tokens are returned once, stored as hashes in PostgreSQL, and can be revoked.
- One Bangkok-calendar-day recovery snapshot is retained before the first accepted write, with 30-day retention. A snapshot is skipped when its state matches the latest stored backup.
- `/api/version` reports the tested v13 release hash used by the daily publisher.
- Users can submit password-recovery cases from the login screen. Admin verifies them personally in v13 Recovery Center, which generates a one-time 24-hour temporary password without changing account state.
- Admin can preview and restore 30-day account snapshots. Full replacement requires a fresh signed preview token, creates a `pre_restore` backup, and increments the cloud revision; credentials are not changed.
- Every signed-in user can open `/data-recovery` (with `/device-recovery` kept as an alias), choose an earlier saved version, preview exact missing/current-only/changed records, and use **Recover Missing Items**. This is additive: current records and settings are not replaced.
- The same page inspects the signed-in account's localStorage, IndexedDB device copy, pending outbox, and allowed legacy browser copy without mutating browser storage.
- The laptop Chrome-to-live pairing bridge is admin-only and loopback-only. Normal accounts use their own same-origin browser session and never receive a pairing token.
- The admin account password is synced from the private `STUDYQUEST_ADMIN_PASSWORD` environment variable on startup. If the admin login stops working, update that Render environment variable and redeploy/restart the service.
- Render Billing showed `No card on file`, `Services $0.00`, `Pipeline Minutes $0.00`, `Total month to date $0.00 USD`, and `Projected total for June $0.00 USD` when checked.
- Free Render web services can spin down after inactivity. The first request after sleep can take about 50-60 seconds to wake.
- Render's own Free Postgres is not a forever database plan because it expires after 30 days. For long-term no-monthly-cost storage, use Neon Free Postgres or another durable database/export plan.

## Save Locations and Statuses

StudyQuest saves to the current device first. Cloud backup is a separate, revision-protected step.

| Location | Purpose | Survives close/offline use | Visible on another device |
| --- | --- | --- | --- |
| Account-scoped `localStorage` | Latest signed-in account state | Yes, in that browser profile | No |
| IndexedDB | Latest device copy, durable upload outbox, and rolling recovery copies | Yes, in that browser profile | No |
| Saved online | Latest revision accepted by `/api/v2/state` | Yes | Yes, for the same signed-in account |
| Immutable versions and snapshots | Recovery history for accepted cloud revisions | Yes | Restored through recovery tools |

- `Saved on this device` or `Saved in Chrome`: the edit is durable on that device and the tab may be closed.
- `Cloud backup pending`: the device copy is safe, but another device may not see it yet. The outbox retries after reopen, reconnect, startup, focus, and visibility changes.
- `Backed up at <time>` or `Synced to admin`: the cloud accepted the revision and other devices can load it.
- `Conflict - both copies preserved`: uploads pause because two copies changed independently. The app retains both until the user reviews and approves a copy or merge.

Every edit writes to IndexedDB and account-scoped browser storage immediately. Online backup starts after a 500 ms quiet period. Page exit makes a final device copy and attempts a best-effort upload; failed or unfinished network work remains in the durable outbox. A stale browser cannot replace an online copy merely because its revision marker matches: hash lineage and record-removal checks are also required. Normal accounts remain isolated and never receive the admin laptop bridge.

### Verified Save-Safety Recovery - August 13, 2026

- Commit `07b5a60` deployed successfully from `main` before any production restoration.
- `/api/version` reported `9667d4c65548327c25ced9f161edea902e398f94b59941e27c3b576b37dab4e7`, matching the tested local and hosted v13 files.
- Live health reported the exact 10 MiB state limit and no browser console errors.
- Admin revision 59 was restored as immutable revision 63, then safely adopted by the live browser as revision 64 after comparison. Final counts were 89 tasks, 20 notes, 2 files, 42 grade records, 1 trip, 4 Weekly weeks, and 4 semesters.
- Revision 62 remains immutable, and `pre_restore` backup 27 preserves its 78-task state. Nothing was deleted from revision history.
- Encrypted pre- and post-recovery database exports both passed decryption and integrity validation. The hidden daily backup task retains 30 daily and 12 monthly copies.
- Stable recovery tests, destructive-drop tests, v13 merge/size/immediate-save checks, schema rollback validation, local bridge checks, inline script parsing, Data Recovery preview, and live Chrome validation passed.

## Best Free Long-Term Setup

Use:

```text
Render Free Web Service + Neon Free Postgres
```

This keeps the app public with HTTPS while keeping the database off your laptop. For a small personal group, this should fit the current free limits comfortably.

Important reality check: no cloud company can truly promise "free forever". Free tiers can change. As of the current docs, this is the best no-monthly-cost setup for this project because Render's free web service can host the Node app, while Neon has a free Postgres plan with no time limit. Render's own free Postgres is not suitable for long-term use because it expires after 30 days.

Only upload/deploy this folder:

```text
studyquest-render-server
```

Do not upload the local files from the parent folder such as `studyquest-accounts.json`, `studyquest-secrets.json`, or the APK download folder.

## What It Provides

- Public HTTPS app URL from Render.
- PostgreSQL database instead of local JSON.
- 5 total accounts by default.
- 10 MiB saved-state limit per account by default.
- Server-side PBKDF2 password hashing with per-password salt.
- HttpOnly session cookies.
- Invite-code required account creation.
- Basic login/register rate limiting.
- Admin-only user summary at `/api/admin/users`.
- Admin-only v13 route and one-time local-device pairing.
- Versioned state writes with explicit conflict responses.
- Thirty days of daily account-state recovery snapshots.

## Render + Neon Setup

1. Create a free Neon Postgres project.
2. Copy the Neon pooled connection string or standard PostgreSQL connection string.
3. Create a new Render Web Service from this folder.

Recommended settings:

```text
Root directory: studyquest-render-server
Build command: npm install
Start command: npm start
```

Set these environment variables on the Render Web Service:

```text
DATABASE_URL=<Neon PostgreSQL connection string>
NODE_ENV=production
STUDYQUEST_ADMIN_PASSWORD=<strong private admin password>
STUDYQUEST_INVITE_CODE=<private invite code for friends>
STUDYQUEST_ADMIN_CONTACT_LABEL=<public contact label shown during recovery>
STUDYQUEST_ADMIN_CONTACT_URL=<optional mailto or https contact link>
STUDYQUEST_MAX_ACCOUNTS=5
STUDYQUEST_MAX_STATE_BYTES=10485760
STUDYQUEST_MAX_STATE_ENVELOPE_BYTES=262144
STUDYQUEST_STATE_HISTORY_BUDGET_BYTES=67108864
PGSSLMODE=require
```

Render sets `PORT` automatically.

The included `render-neon-free.yaml` is the preferred free setup. It creates/configures only the Render web service and asks Render for your Neon `DATABASE_URL`.

The included `render.yaml` uses Render's own Postgres database. Keep it only for short tests or paid Render Postgres. Render's current docs say free Render Postgres databases expire after 30 days.

## First Login

After deployment, open:

```text
https://studyquest-sync-server.onrender.com/app.html
```

For a new clone/service, replace the host with your own Render service URL:

```text
https://YOUR-RENDER-SERVICE.onrender.com/app.html
```

Log in with:

```text
username: admin
password: <STUDYQUEST_ADMIN_PASSWORD>
```

Friends can create accounts only with the invite code.

## Password Recovery

Users select `Forgot password?`, submit their username, and contact admin with the displayed case ID. Public responses do not reveal whether an account exists. Admin approves or denies cases in hosted v13 Recovery Center after personal verification.

Approval replaces only the password record, requires a permanent password change, expires after 24 hours, and revokes existing sessions and paired device tokens. Tasks, grades, notes, files, trips, checklists, state revisions, and backups are not cleared. The generated temporary password is returned once and is never stored as plaintext.

The `admin` account cannot be reset inside StudyQuest. Change `STUDYQUEST_ADMIN_PASSWORD` in Render and redeploy instead.

## Account Save Recovery

- After authentication, the stable app reloads the signed-in user's browser key, such as `studyquest_v3_anya`, before accepting edits.
- Hosted v13 uses that same authenticated per-account key. The `onrender.com` browser store and `127.0.0.1` browser store are separate browser origins; localhost reaches the admin account through the revision-protected cloud bridge rather than by exposing localhost storage to the website.
- When device and online data differ, neither copy is silently applied. The popup uses the plain labels **On This Device** and **Saved Online**, shows removal details under **More details**, and offers export before any choice.
- Recovery copies use an auxiliary per-account browser key. The main `studyquest_v3` data family is never cleared automatically.
- The browser also stores the current account copy, offline outbox, and rolling recovery records in IndexedDB. Failed requests remain `Cloud backup pending` and retry after reconnect, focus, startup, and returning to the tab.
- Cloud status text distinguishes `Saved on this device`, `Cloud backup pending`, `Backed up at <time>`, and `Conflict - both copies preserved`.
- **Review This Device** is a two-step action. It shows how many online records would be removed and requires a second confirmation. It uses the normal hash/revision/change-manifest guard; the former `stable-account-recovery` whole-copy bypass no longer exists.
- Revision conflicts open the same recovery comparison for non-admin users instead of directing them to an admin-only screen.
- `/data-recovery` lists only the signed-in user's immutable versions. Preview is read-only; **Recover Missing Items** adds absent records transactionally after a fresh signed preview and first creates a `pre_restore` snapshot.
- `/device-recovery` remains an alias to the same recovery page. Device-copy inspection/export does not write browser storage.

### August 13, 2026 Save-Safety Incident

The admin account's revision 59 contained 89 tasks, one trip, and four Weekly weeks. A browser `localStorage` quota failure left an older 78-task copy on disk while its revision marker advanced; startup migrations then queued that old copy, and the old server accepted it because the revision number matched. The new safeguards address each failure point:

- IndexedDB is the authoritative recovery copy and outbox; large v13 undo, auto-backup, and diagnostic histories no longer keep filling localStorage.
- Hosted v13 blocks editing while account/device/online sources load and migrations cannot create a user-edit upload.
- Revision equality is insufficient without the matching base hash.
- The server independently detects removed records and requires explicit deletion evidence.
- Each accepted revision and blocked attempt remains auditable, and every user has additive self-service missing-item recovery.

## Migrating Current Admin Data

The hosted server starts with an empty admin state unless you import your local data.

Your current local data is in:

```text
../studyquest-accounts.json
```

To migrate safely, use the signed-in app's comparison screen or POST the state to `/api/v2/state` with the current `baseRevision`. The old unversioned `POST /api/state` route is deliberately disabled. Do not upload `studyquest-accounts.json` itself because it contains password hashes and sessions.

## Encrypted Laptop Backups

The backup scripts under `scripts/` create AES-256-GCM encrypted database exports. They include accounts, account states, server snapshots, immutable revisions, save-event metadata, and password-recovery cases. Sessions, pairing codes, and device tokens are explicitly excluded.

Setup is local-only. Protect the Neon connection string and a random encryption key with Windows DPAPI, then install the hidden daily task:

```powershell
.\scripts\configure-database-backup.ps1 -DatabaseUrl '<Neon connection string>'
.\scripts\run-database-backup.ps1
.\scripts\install-database-backup-task.ps1
```

`StudyQuest Encrypted Database Backup` runs at 03:30 with `StartWhenAvailable`, retains 30 daily and 12 monthly files under `%LOCALAPPDATA%\StudyQuest\database-backups`, and decrypt-validates each new backup before reporting success. The DPAPI files can only be unprotected by the same Windows user. Never commit those files.

## Android App

The Android app has a Connect screen. Paste the hosted URL:

```text
https://studyquest-sync-server.onrender.com/app.html
```

For a new clone/service, replace the host with your own Render service URL:

```text
https://YOUR-RENDER-SERVICE.onrender.com/app.html
```

After it connects once, the app remembers that URL.

## Storage Estimate

With the default limits, PostgreSQL app data is capped at roughly:

```text
5 accounts * 10 MiB state each = up to about 50 MiB of current user state
```

The database also stores account rows, sessions, indexes, snapshots, compressed revisions, and save-event metadata. Recovery Center reports current database and compressed-history usage. The default compressed-history budget is 64 MiB per account; the newest 100 revisions remain recoverable, with older hourly checkpoints through 30 days and daily checkpoints through 90 days while within that budget.

## Safety Notes

- Do not commit real passwords or invite codes.
- Keep the Render environment variables private.
- Keep account creation invite-only.
- Use a strong admin password.
- Rotate the invite code if it leaks.
- Keep Render billing/spend limits at zero unless you decide to upgrade later.
- The per-account state cap is 10 MiB (10,485,760 UTF-8 bytes). The API allows a separate 256 KiB revision/merge envelope and returns structured `STATE_TOO_LARGE` details without deleting browser data.
- Recovery Center warns at 80% and 95%. A worst-case 10 MiB account can create large 30-day backups, so monitor the reported PostgreSQL database size and keep regular exports.
