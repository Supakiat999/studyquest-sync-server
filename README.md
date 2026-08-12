# StudyQuest Hosted Server

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
- `/api/v2/state` uses revisions and returns `409 STATE_CONFLICT` instead of silently replacing a newer account save.
- Paired Chrome and live admin v13 compare changes every 30 minutes. Chrome-versus-local-server, imported, and live differences all require a per-field Smart Merge preview; browser and local-disk saves remain immediate.
- `_syncMeta` records stable IDs, per-field update stamps, deletion tombstones, additive counters, and 90 days or 500 visible change events. Legacy/tied/unverified differences require a manual choice.
- Recovery Center reports sync times, per-field decisions, change history, and saved-state usage. Chrome, Live, and the proposed merge can be exported together before applying.
- Weekly curriculum is stored inside each account's state. New Weekly users choose ICE, BALAC, Industrial Pharmacy, a custom curriculum, or a blank program instead of receiving ICE automatically.
- Existing Weekly semesters, weeks, notes, checks, and edited course lists are migrated additively. `Edit Subjects` remains the per-semester source for that user's course names and weekdays.
- One-time admin pairing codes expire after 10 minutes. Device tokens are returned once, stored as hashes in PostgreSQL, and can be revoked.
- One Bangkok-calendar-day recovery snapshot is retained before the first accepted write, with 30-day retention. A snapshot is skipped when its state matches the latest stored backup.
- `/api/version` reports the tested v13 release hash used by the daily publisher.
- Users can submit password-recovery cases from the login screen. Admin verifies them personally in v13 Recovery Center, which generates a one-time 24-hour temporary password without changing account state.
- Admin can preview and restore 30-day account snapshots. Every restore creates a `pre_restore` backup and increments the cloud revision; credentials are not changed.
- The admin account password is synced from the private `STUDYQUEST_ADMIN_PASSWORD` environment variable on startup. If the admin login stops working, update that Render environment variable and redeploy/restart the service.
- Render Billing showed `No card on file`, `Services $0.00`, `Pipeline Minutes $0.00`, `Total month to date $0.00 USD`, and `Projected total for June $0.00 USD` when checked.
- Free Render web services can spin down after inactivity. The first request after sleep can take about 50-60 seconds to wake.
- Render's own Free Postgres is not a forever database plan because it expires after 30 days. For long-term no-monthly-cost storage, use Neon Free Postgres or another durable database/export plan.

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
- When browser and cloud contain different user data, neither copy is silently applied. The user sees `Unsynced work found` and can choose `Export Both`, `Use Cloud`, or `Use This Browser`.
- Recovery copies use an auxiliary per-account browser key. The main `studyquest_v3` data family is never cleared automatically.
- `Use This Browser` sends an explicit `stable-account-recovery` approval and creates a server-side `pre_merge` snapshot before cloud replacement.
- Revision conflicts open the same recovery comparison for non-admin users instead of directing them to an admin-only screen.

## Migrating Current Admin Data

The hosted server starts with an empty admin state unless you import your local data.

Your current local data is in:

```text
../studyquest-accounts.json
```

To migrate safely, export only the `admin.state` object and POST it to the hosted `/api/state` endpoint after logging in as admin. Do not upload `studyquest-accounts.json` itself because it contains password hashes and sessions.

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

The database also stores account rows, sessions, indexes, and recovery snapshots. Recovery Center reports the current database size because 30 days of frequently changing near-limit saves can use substantially more than the current-state total.

## Safety Notes

- Do not commit real passwords or invite codes.
- Keep the Render environment variables private.
- Keep account creation invite-only.
- Use a strong admin password.
- Rotate the invite code if it leaks.
- Keep Render billing/spend limits at zero unless you decide to upgrade later.
- The per-account state cap is 10 MiB (10,485,760 UTF-8 bytes). The API allows a separate 256 KiB revision/merge envelope and returns structured `STATE_TOO_LARGE` details without deleting browser data.
- Recovery Center warns at 80% and 95%. A worst-case 10 MiB account can create large 30-day backups, so monitor the reported PostgreSQL database size and keep regular exports.
