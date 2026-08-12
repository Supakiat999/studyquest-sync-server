# StudyQuest Operations Guide

The complete setup, use, save-safety, backup, password-recovery, admin v13,
release, incident-response, and LINE operations guide is maintained in this
repository.

The detailed guide in the admin workspace is the source used for operations.
This hosted-repository copy documents the live server portion and links the
important entry points without containing any secret values.

## Live Links

- Stable app: <https://studyquest-sync-server.onrender.com/app.html?stable=1>
- Admin-only v13: <https://studyquest-sync-server.onrender.com/v13>
- Device recovery: <https://studyquest-sync-server.onrender.com/device-recovery>
- Health: <https://studyquest-sync-server.onrender.com/api/health>
- Version: <https://studyquest-sync-server.onrender.com/api/version>
- Source: <https://github.com/Supakiat999/studyquest-sync-server>
- Admin-only LINE Worker health: <https://line-study-brief.manusirivithaya.workers.dev/health>

## Save Model

StudyQuest writes every edit to the signed-in account's browser storage and
IndexedDB before attempting a cloud request. A durable outbox retries after
startup, reconnect, focus, and returning to the page. Cloud writes use
`/api/v2/state` with a base revision; stale copies receive
`409 STATE_CONFLICT` and cannot silently replace newer cloud state.

Status meanings:

- `Saved on this device`: the browser copy is durable.
- `Cloud backup pending`: device copy is safe and queued for cloud.
- `Backed up at <time>`: cloud accepted the revision.
- `Conflict - both copies preserved`: export/review both before choosing.

Normal accounts are isolated and never receive the admin laptop bridge.
`/device-recovery` reads only the current account's device copies and does not
load or write cloud state.

## Render and Neon

Recommended Render settings:

```text
Build command: npm install
Start command: npm start
Health check: /api/health
```

Required environment:

```text
DATABASE_URL=<private Neon PostgreSQL connection string>
NODE_ENV=production
STUDYQUEST_ADMIN_PASSWORD=<private strong admin password>
STUDYQUEST_INVITE_CODE=<private invite code>
STUDYQUEST_ADMIN_CONTACT_LABEL=<safe public contact label>
STUDYQUEST_ADMIN_CONTACT_URL=<optional mailto or https URL>
STUDYQUEST_MAX_ACCOUNTS=5
STUDYQUEST_MAX_STATE_BYTES=10485760
STUDYQUEST_MAX_STATE_ENVELOPE_BYTES=262144
STUDYQUEST_STATE_HISTORY_BUDGET_BYTES=67108864
PGSSLMODE=require
```

Use `render-neon-free.yaml` for Render Free plus Neon. Do not commit any real
environment value.

## Accounts and Password Recovery

The `admin` password is controlled by `STUDYQUEST_ADMIN_PASSWORD`. Other users
create isolated accounts with the invite code.

A normal user selects `Forgot password?`, gives the case ID to admin, and is
verified personally. Admin approves the case in v13 Recovery Center and
delivers the one-time 24-hour temporary password privately. The user must choose
a new permanent password. Recovery changes credentials only and preserves all
StudyQuest data.

Admin recovery is performed by changing `STUDYQUEST_ADMIN_PASSWORD` in Render
and restarting/redeploying. It is never performed inside StudyQuest.

## Cloud Recovery

- Every unique accepted revision is compressed into immutable
  `state_versions`.
- Save outcomes are logged in `state_save_events` without state bodies or
  passwords.
- Snapshot restore creates a `pre_restore` snapshot and increments revision.
- Encrypted laptop exports include account state, revisions, snapshots,
  save-event metadata, and recovery cases while excluding sessions and device
  tokens.

Backup setup from this checkout:

```powershell
.\scripts\configure-database-backup.ps1 -DatabaseUrl '<private Neon URL>'
.\scripts\run-database-backup.ps1
.\scripts\install-database-backup-task.ps1
```

The hidden task runs at 03:30 with `StartWhenAvailable`, keeps 30 daily and 12
monthly AES-256-GCM backups, and decrypt-validates every new file.

## Checks

```powershell
npm install
npm.cmd run check
Invoke-RestMethod https://studyquest-sync-server.onrender.com/api/health
Invoke-RestMethod https://studyquest-sync-server.onrender.com/api/version
```

During an incident, stop editing, preserve the original browser profile, export
device and cloud copies, create an encrypted database backup, inspect revision
history, and restore or merge only after an explicit reviewed preview.

For the complete local-v13, LINE, scheduled-task, GitHub publishing, and
troubleshooting procedures, use `STUDYQUEST-OPERATIONS-GUIDE.md` in the admin
workspace. Never place secrets in either copy.
