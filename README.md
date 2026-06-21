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

Experimental v13 beta:

```text
https://studyquest-sync-server.onrender.com/v13
```

Current Render service:

```text
studyquest-sync-server
```

Deployment notes from June 21, 2026:

- Render shows this web service as `Node Free`.
- The `/app.html` route is enabled by commit `ca06691389394c9a9105d0718587fc3dc68773af`, which runs `scripts/route-alias-patch.js` before `server.js` starts.
- The `/v13` and `/claudever13.html` routes serve the experimental v13 beta. The main beta header shows a `v13 Beta` button with an export-backup prompt before opening v13.
- v13 shares the same account state as the main beta, so users should export a backup before testing. Hosted v13 redirects logged-out users back to `/app.html` instead of silently saving local/default data.
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
- 1 MB saved-state limit per account by default.
- Server-side PBKDF2 password hashing with per-password salt.
- HttpOnly session cookies.
- Invite-code required account creation.
- Basic login/register rate limiting.
- Admin-only user summary at `/api/admin/users`.

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
STUDYQUEST_MAX_ACCOUNTS=5
STUDYQUEST_MAX_STATE_BYTES=1048576
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
5 accounts * 1 MB state each = about 5 MB user state
```

The database will have some overhead for account rows, sessions, indexes, and JSONB storage, so plan for roughly 10-25 MB for normal usage by 5 people.

## Safety Notes

- Do not commit real passwords or invite codes.
- Keep the Render environment variables private.
- Keep account creation invite-only.
- Use a strong admin password.
- Rotate the invite code if it leaks.
- Keep Render billing/spend limits at zero unless you decide to upgrade later.
- If you raise `STUDYQUEST_MAX_STATE_BYTES`, also raise PostgreSQL storage expectations.
