# StudyQuest Hosted Server

This folder is a Render-ready StudyQuest sync server backed by PostgreSQL.

It is separate from the local laptop sync bridge. The hosted version is the better long-term option when friends do not want to use Tailscale.

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
https://YOUR-RENDER-SERVICE.onrender.com/claudever9.html
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
https://YOUR-RENDER-SERVICE.onrender.com/claudever9.html
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
