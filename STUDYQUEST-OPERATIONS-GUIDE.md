# StudyQuest Operations Guide

This is the authoritative setup, use, backup, recovery, release, and LINE guide
for StudyQuest. Follow it in order when setting up a new machine. During an
incident, start with [Emergency Recovery](#emergency-recovery).

The same file is mirrored in the hosted GitHub repository. Commands for local
v13, LINE, and publishing run from the admin workspace. Hosted-server and
database script commands run from its `live-smart-merge-release` checkout.

No real password, invite code, database URL, LINE secret, sync token, or device
token belongs in this file or in Git.

## 1. System Map

StudyQuest has separate device and cloud copies:

| Part | Location | Purpose |
| --- | --- | --- |
| Local admin v13 | `http://127.0.0.1:3000/claudever13.html` | Admin's authoritative Chrome test environment on this laptop |
| Stable live app | `https://studyquest-sync-server.onrender.com/app.html?stable=1` | Normal app for Anya and other users |
| Live admin v13 | `https://studyquest-sync-server.onrender.com/v13` | Admin-only hosted v13 |
| Live v14 Weekly customization | `https://studyquest-sync-server.onrender.com/v14` | Signed-in account route; each user sees only their own data |
| Data recovery | `https://studyquest-sync-server.onrender.com/data-recovery` | Own-version missing-item recovery plus device-copy inspection/export |
| Render server | `studyquest-sync-server` | Login, account isolation, state API, recovery API |
| Neon PostgreSQL | Private `DATABASE_URL` | Durable account state, revisions, snapshots, recovery records |
| LINE Worker | `https://line-study-brief.manusirivithaya.workers.dev` | Always-on admin-only LINE replies and scheduled briefs |
| GitHub repository | `https://github.com/Supakiat999/studyquest-sync-server` | Source used by Render |

Browser storage is isolated by origin. The local page on `127.0.0.1` cannot
directly read the browser storage of `onrender.com`, even in the same Chrome
profile. Data moves between them only through authenticated, revision-protected
APIs and the admin-only comparison flow.

Normal users never use the laptop bridge. Their browser saves to their own
account-scoped device copy and then to their own cloud account.

## 2. What Save Messages Mean

| Message | Meaning | May the tab be closed? |
| --- | --- | --- |
| `Saving on this device` | Browser storage is being updated | Wait briefly |
| `Saved on this device` / `Saved in Chrome` | The edit is durable in this browser | Yes |
| `Cloud backup pending` | Device copy is safe; cloud has not accepted it yet | Yes; the outbox retries after reopen |
| `Backed up at <time>` | Cloud accepted the revision | Yes |
| `Synced to admin` | Local admin and live admin agree | Yes |
| `Conflict - both copies preserved` | Two copies changed independently | Yes; review before applying anything |

Every normal edit is written immediately to account-scoped `localStorage` and
IndexedDB. Cloud backup begins after a short quiet period. Closing or hiding the
page writes another device copy and attempts a revision-protected upload. If
that request cannot finish, the durable IndexedDB outbox retries on startup,
reconnect, focus, and returning to the page.

Never clear browser data while recovering an account. Never use an incognito
window for important edits.

## 3. Everyday Use

### Normal users

1. Open the [stable app](https://studyquest-sync-server.onrender.com/app.html?stable=1).
2. Log in with the user's own account. The secure session is remembered on that
   browser for up to 30 days unless the user logs out or the session is revoked.
3. Add or edit information normally.
4. Before changing devices, wait for `Backed up at <time>`.
5. If the app says `Cloud backup pending`, the current device copy is safe.
   Reopen it online and keep the page visible until backup completes.
6. If a conflict appears, export both copies before choosing. Do not repeatedly
   press Save or refresh.

### Admin on this laptop

1. Open `http://127.0.0.1:3000/claudever13.html` in the normal Chrome profile.
2. Confirm the status says `Saved in Chrome`, `Synced to admin`, or clearly
   explains why sync is pending.
3. Use Recovery Center to compare local and live copies.
4. A comparison is read-only. Review the preselected latest values, resolve any
   manual rows, export when important, and click `Approve Merge` once.
5. Use the live admin route only for hosted validation. Local and live browser
   storage are expected to differ until the approved bridge synchronization
   completes.

### Weekly tracker

Weekly data belongs to each account. A new user chooses a curriculum or blank
program. `Edit Subjects` is the source of truth for each semester's courses and
weekdays. Changes by one account do not change another account.

## 4. First-Time Live Setup

### Requirements

- Node.js 20 or newer
- Git and GitHub CLI (`gh`)
- A Render web service
- A Neon PostgreSQL project
- A Cloudflare account for the LINE Worker
- A LINE Official Account with a Messaging API channel

### Render and Neon

Use the repository checkout in `live-smart-merge-release`. In Render, use:

```text
Build command: npm install
Start command: npm start
Health check: /api/health
```

Set these Render environment variables. Values marked private must be entered
in Render and never committed:

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

Use `render-neon-free.yaml` for the Render Free + Neon setup. Do not add a
Render disk or paid database unless a deliberate billing decision has been
made.

After deployment, verify:

```powershell
Invoke-RestMethod https://studyquest-sync-server.onrender.com/api/health
Invoke-RestMethod https://studyquest-sync-server.onrender.com/api/version
```

`ok` must be true. Health must report `maxStateBytes: 10485760`.

### Accounts

- The `admin` credential comes from `STUDYQUEST_ADMIN_PASSWORD`.
- Other users create their own account with the private invite code.
- Usernames are normalized by the server and each account has isolated state.
- Never share the admin password or a user's temporary recovery password.

## 5. Local Admin v13 Setup

From the workspace:

```powershell
npm install
npm.cmd run check:v13
npm.cmd run install:v13:server-task
```

The scheduled task `StudyQuest v13 Local Server` starts the server hidden after
Windows login and keeps the fixed address `127.0.0.1:3000`. It does not choose
another port. Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

### Pair local Chrome with live admin

1. Sign in as `admin` at the live v13 route.
2. Open Recovery Center and generate a one-time device pairing code.
3. Open local v13 Recovery Center and enter that code.
4. Before the first cross-copy write, export or keep the automatically created
   Chrome, local-server, and live snapshots.
5. Review the first comparison and explicitly choose or approve a merge.

The device token belongs only to `admin` and is stored at:

```text
%LOCALAPPDATA%\StudyQuest\live-sync-device.json
```

It is never stored in HTML or browser storage. Pairing codes expire after ten
minutes and work once. Revoke an unfamiliar device in Recovery Center.

## 6. LINE Admin Setup

The Cloudflare Worker is the only normal scheduler. It sends the morning brief
at 06:30 Bangkok time and the next-day brief at 21:00 Bangkok time, even when
the laptop is off. The laptop task named `StudyQuest Task Sync` refreshes task
and Chrome/live comparison metadata every 30 minutes; it does not send LINE
messages.

LINE replies and scheduled briefs are restricted to one linked direct admin
chat. Missing recipient setup fails closed. StudyQuest never broadcasts admin
tasks to every Official Account friend.

### Create the private local configuration

```powershell
Copy-Item line-daily.env.example line-daily.env
```

Fill `line-daily.env` with:

```text
LINE_CHANNEL_ID=<LINE Basic settings channel ID>
LINE_CHANNEL_SECRET=<private LINE channel secret>
WORKER_URL=https://line-study-brief.manusirivithaya.workers.dev
SYNC_TOKEN=<same private random value stored as the Worker SYNC_TOKEN secret>
```

Leave `LINE_CHANNEL_ACCESS_TOKEN` blank when using channel ID plus channel
secret. The code mints and renews a 30-day token before it expires.

`line-daily.env`, `.line-token-cache.json`, and all Worker secrets are
gitignored. Do not paste their values into documentation, screenshots, issues,
or chat.

### Configure Worker secrets

From the workspace:

```powershell
npx.cmd wrangler secret put LINE_CHANNEL_SECRET --config worker/wrangler.jsonc
npx.cmd wrangler secret put SYNC_TOKEN --config worker/wrangler.jsonc
npm.cmd run worker:deploy
```

Use exactly the same `SYNC_TOKEN` in `line-daily.env`. The Worker config
contains only non-secret `LINE_CHANNEL_ID` and `LIVE_ORIGIN`.

### Pair the Worker to the live StudyQuest admin account

1. In live v13 Recovery Center, generate an admin device pairing code.
2. Run:

```powershell
npm.cmd run worker:pair -- <PAIRING-CODE>
```

This stores `LIVE_SYNC_TOKEN` directly as a Worker secret without printing it.
The server rejects a pairing token for any account except `admin`.

### Configure the LINE webhook

In LINE Developers Console, set:

```text
Webhook URL:
https://line-study-brief.manusirivithaya.workers.dev/line/webhook
```

Enable `Use webhook`. In LINE Official Account Manager, disable greeting and
automatic response messages if they would duplicate the Worker reply. Add the
Official Account as a friend in the admin's LINE app.

### Link the one admin chat

```powershell
npm.cmd run line:admin:link
```

The command prints a ten-minute one-time message such as `link ABC...`. Send
that exact message in a direct chat with the Official Account. After LINE
confirms the link:

```powershell
npm.cmd run line:admin:status
npm.cmd run line:admin:sync-local
```

The second command copies the linked ID into the gitignored local env file
without printing it. It enables the local emergency sender and menu installer.

### Install and verify the admin-only rich menu

```powershell
npm.cmd run menu:preview
npm.cmd run menu:install
npm.cmd run line:admin:check
```

`line:admin:check` is read-only and sends no message. It verifies the linked
admin chat, friendship/profile access, StudyQuest admin pairing, task freshness,
LINE allowance, credentials, active Worker webhook, and installed admin rich
menu.

Menu behavior:

| Button | Result |
| --- | --- |
| Today | Today's schedule, classwork, and tasks |
| Tomorrow | Tomorrow's plan |
| Tasks | Due, overdue, and next-seven-day tasks |
| Exams | Every remaining midterm, final, final project, and presentation |
| Week | Current week overview |
| Help | Available commands |

The Exams reply includes date, `Today`/`Tomorrow`/`In N days`, start/end
time, and room or `Room TBA`. Daily briefs keep the shorter 14-day exam warning
window. Long exam lists are safely split within LINE's five-message reply limit.

### LINE checks and maintenance

```powershell
npm.cmd run check:line
npm.cmd run line:preview
npm.cmd run line:admin:status
npm.cmd run menu:verify
npm.cmd run worker:pull
```

- `check:line` validates the schedule, all 13 configured assessments, message
  splitting, and admin-only/no-broadcast safety markers.
- `line:preview` builds the current brief without sending it.
- `line:admin:status` verifies delivery without consuming a message.
- `worker:pull` immediately refreshes the Worker from live admin state.

Do not install the two legacy laptop LINE send tasks while Worker cron is
enabled. The installer now creates only the local digest page by default. The
`-InstallLocalLineFallback` switch is for a deliberate emergency fallback and
requires a valid linked admin recipient.

## 7. Automatic Windows Tasks

Expected tasks on the admin laptop:

| Task | Schedule | Purpose |
| --- | --- | --- |
| `StudyQuest v13 Local Server` | At login | Hidden fixed-port local app server |
| `StudyQuest Task Sync` | Every 30 minutes | Refresh LINE task/comparison cache |
| `StudyQuest v13 Daily Admin Release` | 03:00 | Publish tested changed v13 |
| `StudyQuest Encrypted Database Backup` | 03:30 | Encrypted cloud database export |
| `StudyQuest Digest Page` | 06:25 and 20:55 | Refresh local HTML preview only |

The LINE morning/evening delivery itself runs in Cloudflare, not Windows.

Read-only status check:

```powershell
Get-ScheduledTask | Where-Object TaskName -like 'StudyQuest*'
Get-ScheduledTaskInfo -TaskName 'StudyQuest Encrypted Database Backup'
```

Reinstall tasks with:

```powershell
npm.cmd run install:v13:server-task
npm.cmd run install:v13:release-task
npm.cmd run install:line:sync-task
& .\live-smart-merge-release\scripts\install-database-backup-task.ps1
```

All installed actions should be hidden. A terminal window appearing on schedule
means the task action is stale and should be reinstalled from the current script.

## 8. Backups and Recovery

### Browser backups

- Export a StudyQuest backup before a large import, merge, or curriculum change.
- Local v13 keeps undo history and automatic safety snapshots.
- The stable app and v13 keep account-scoped localStorage, IndexedDB device
  copies, and a durable outbox.
- `/data-recovery` lists only the signed-in account's immutable online versions
  and reads its device copies. Preview changes nothing. **Recover Missing Items**
  adds absent records only after approval and a server `pre_restore` snapshot.
- `/device-recovery` remains an alias. Browser-storage inspection and export are
  read-only; recovery writes use only the dedicated signed-preview API.

### Cloud history

Every unique accepted revision is compressed into immutable
`state_versions`. Save events record accepted, unchanged, conflicted, blocked,
recovered, restored, and oversized attempts without recording passwords or state bodies. Daily
snapshots and pre-merge/pre-restore snapshots provide additional restore points.

Every normal save carries revision/hash lineage, a retry-safe mutation ID, and
a record-change manifest. The server independently compares record IDs. An
unexplained removal is blocked with `DESTRUCTIVE_CHANGE_REVIEW_REQUIRED`; the
device and online copies remain available for review.

### Recover missing items yourself

1. Stop editing the account on other devices.
2. Open `/data-recovery` while signed in to the affected account.
3. Choose an **Earlier Saved Version** by Bangkok date/time and counts.
4. Select **Preview**. Read **Items that will be added**; open **More details**
   for current-only and changed records.
5. Select **Recover Missing Items** and approve once.
6. Reopen StudyQuest and verify tasks, Weekly weeks/semesters, notes, files,
   grades, trips, and checklists.

This action is additive. It does not replace current records, settings, or
credentials. Full-version replacement remains admin-only.

### Encrypted laptop database backup

One-time setup:

```powershell
& .\live-smart-merge-release\scripts\configure-database-backup.ps1 -DatabaseUrl '<private Neon URL>'
& .\live-smart-merge-release\scripts\run-database-backup.ps1
& .\live-smart-merge-release\scripts\install-database-backup-task.ps1
```

Secrets are protected with Windows DPAPI under
`%LOCALAPPDATA%\StudyQuest`. Backups use AES-256-GCM, are decrypted and
checksum-validated immediately, retain 30 daily and 12 monthly files, and live
under:

```text
%LOCALAPPDATA%\StudyQuest\database-backups
```

Sessions, pairing codes, and device tokens are excluded from database exports.

### Safe snapshot restore

1. Stop editing the affected account on every device.
2. Export the current browser and cloud copies.
3. In admin Recovery Center, inspect snapshot date, reason, revision, and counts.
4. Select the correct snapshot or immutable version, generate its preview, and
   inspect the additions, removals, and changed-record counts.
5. Confirm the fresh signed preview. The server creates a `pre_restore` snapshot, restores transactionally, and
   increments the state revision.
6. Reopen the affected user's app and resolve the expected stale-device conflict.
7. Verify tasks, Weekly weeks/semesters, notes, files, grades, trips, and
   checklists before resuming edits.

## 9. Password Recovery

### Normal user

1. User selects `Forgot password?` and submits their username.
2. StudyQuest returns a case ID without revealing whether the account exists.
3. User contacts the admin personally and provides the case ID.
4. Admin verifies identity outside StudyQuest.
5. Admin opens live v13 Recovery Center and approves or denies the case.
6. Approval generates a one-time temporary password valid for 24 hours.
7. Admin delivers it privately. The user must immediately choose a permanent
   password.

Approval changes credentials only. It does not clear tasks, grades, notes,
files, trips, checklist items, Weekly data, XP, revisions, or backups. Approval
revokes old sessions and paired device tokens.

### Admin forgot the password

The admin account cannot be reset inside StudyQuest. In Render:

1. Change the private `STUDYQUEST_ADMIN_PASSWORD` environment variable.
2. Save and redeploy or restart the service.
3. Log in with the new password.
4. Re-pair any revoked local or LINE device only if needed.

Never place the admin password in Git, this guide, or a support message.

## 10. Safe v13 Release

The publisher must use only `live-smart-merge-release`. Do not stash, reset,
commit, or clean the unrelated `live-release` or `live-v13-release` folders.

Before release:

```powershell
npm.cmd run check:v13
npm.cmd run test:v13:sync
npm.cmd run test:v13:merge
npm.cmd run test:v13:size
npm.cmd run test:local-bridge
npm.cmd run release:v13:dry-run
```

Manual release:

```powershell
npm.cmd run release:v13
```

The publisher:

- validates inline JavaScript and safety markers;
- confirms `STORAGE_KEY` remains `studyquest_v3`;
- refuses a dirty or diverged release checkout;
- copies only the tested v13 and version metadata;
- never force-pushes;
- polls live health and exact SHA-256 version;
- reverts only its own commit if that exact deployment is unhealthy and no
  newer commit exists.

Install the hidden daily release:

```powershell
npm.cmd run install:v13:release-task
```

GitHub authentication:

```powershell
gh auth status -h github.com
gh auth login -h github.com --web
```

The `code50` organization shown on GitHub's authorization page is an
organization associated with the GitHub account. It is not a password, login
code, or a person receiving the repository. Repository access is governed by
the permissions shown on the authorization page and GitHub account settings.

## 10A. Safe v14 Release

v14 is a separate Weekly customization route. It is not the default app and it
does not replace v13. The release branch must contain only the tested
`public/claudever14.html`, `public/v14-version.json`, the v14 route/status
support, tests, and documentation.

Run the release checkout checks before opening a PR:

```powershell
npm.cmd run check
```

The checks confirm that:

- v13's hosted SHA-256 is unchanged;
- v14 inline JavaScript, route metadata, and version hash are valid;
- `/v14` requires a normal signed-in account session, rejects logged-out and device-token requests, and follows `STUDYQUEST_V14_ACCESS` (`off`, `admin`, or `all`);
- Weekly column counts and latest-change summaries are present;
- merge approval remains explicit and revision-protected;
- no browser storage is cleared or silently replaced.

The v14 status view reports total, visible, and archived Weekly columns for
each copy. It also shows the latest five reliable changes and calls out the
newest task addition with its Bangkok time. Missing legacy history is shown as
unavailable rather than guessed. A comparison remains read-only until the
user resolves uncertain fields and clicks **Approve Merge**.

For this release, create a protected branch from the current `origin/main`,
push it after GitHub browser authentication, and open a PR. Stop at the PR:
Render must not deploy v14 until the owner reviews and merges it. Never force
push, and never use the dirty `live-release` or `live-v13-release` folders.

## 11. Emergency Recovery

When data appears missing:

1. Stop editing. Do not clear site data, log out repeatedly, import a random
   backup, or approve a merge.
2. Keep the original device and browser profile open.
3. Record username, device, browser, exact time in Bangkok, URL, and visible save
   status.
4. Open `/data-recovery` on that same signed-in device and export its copies.
5. Export the current cloud copy and create an encrypted database backup.
6. Inspect cloud revisions, daily snapshots, save events, and account counts.
7. Compare by stable record IDs and field timestamps. Preserve both copies.
8. Prefer **Recover Missing Items**. Use a full replacement only as admin after
   a fresh preview, backup, and explicit approval.
9. Verify every data area and account isolation after recovery.
10. Write an incident note with cause, evidence, recovery source, hashes/counts,
    and safeguards added.

Network failure is allowed; silent loss is not. A failed cloud request should
leave the device copy and outbox intact.

## 12. Troubleshooting

| Problem | Safe response |
| --- | --- |
| Render page says Not Found | Use `/app.html?stable=1`; then check `/api/health` and the latest deploy |
| First live load is slow | Wait for Render Free to wake; do not keep submitting forms |
| Data appears empty | Stop editing and open `/data-recovery`; export device copies and preview an earlier version |
| `Cloud backup pending` | Keep the browser data; reconnect and reopen the page |
| Two Saved Copies popup | Export both, compare **On This Device** and **Saved Online**, open **More details**, then approve once |
| Save blocked as destructive | Do not retry blindly. Export both copies and recover/merge through a preview |
| Admin login fails | Check/update `STUDYQUEST_ADMIN_PASSWORD` in Render |
| User forgot password | Use the recovery case and admin approval flow |
| LINE menu does not reply | Run `line:admin:status`; check webhook is enabled and chat is linked |
| LINE recipient check fails | Add the Official Account as a friend, relink, then sync local ID |
| LINE sends nothing at scheduled time | Check Worker health, recipient link, quota, and cron logs |
| LINE tasks are stale | Run `worker:pull` and inspect `StudyQuest Task Sync` |
| Duplicate LINE brief | Remove legacy Windows LINE Morning/Evening tasks; keep Worker cron |
| A PowerShell window flashes | Reinstall the affected hidden scheduled task |
| Daily release fails | Read `studyquest-v13-release-status.json`; do not bypass failed checks |
| State exceeds 10 MiB | Keep device copy, export it, clean attachments/history intentionally |

## 13. Free-Tier and Security Rules

- Render, Neon, Cloudflare, LINE, and GitHub free limits can change. Check their
  dashboards before adding services or enabling billing.
- Do not add a card, paid disk, paid database, or upgraded service during
  maintenance unless the owner explicitly approves it.
- Render Free may sleep; this affects wake time, not the browser's immediate
  device save.
- The LINE sender checks the current monthly allowance and refuses to send after
  the free allowance is exhausted.
- Scheduled LINE retries use a stable 24-hour retry key, so a network timeout or
  repeated cron delivery cannot create a duplicate brief for the same date and
  mode.
- Keep Render environment values, Neon URL, LINE secret, sync token, backup key,
  GitHub credentials, and device tokens private.
- Rotate a secret immediately if it appears in Git, a screenshot, a log, or chat.
- Only `admin` may use local live-sync/release endpoints. They bind to
  `127.0.0.1` and reject non-loopback callers.

Official references:

- Render Free: <https://render.com/docs/free>
- Neon plans and limits: <https://neon.com/pricing>
- LINE user IDs: <https://developers.line.biz/en/docs/messaging-api/getting-user-ids/>
- LINE message types: <https://developers.line.biz/en/docs/messaging-api/sending-messages/>
- Cloudflare Workers: <https://developers.cloudflare.com/workers/>

## 14. Full Verification Checklist

Run this after setup, a deployment, or a recovery:

```powershell
npm.cmd run check:v13
npm.cmd run test:v13:sync
npm.cmd run test:v13:merge
npm.cmd run test:v13:size
npm.cmd run test:local-bridge
npm.cmd run check:line
npm.cmd run test:comparison
npm.cmd run line:preview
npm.cmd run line:admin:check
npm.cmd run release:v13:dry-run
Push-Location .\live-smart-merge-release
npm.cmd run check
Pop-Location
```

Then verify:

- local `/api/health` returns HTTP 200;
- live `/api/health` is healthy and reports the 10 MiB limit;
- live `/api/version` matches the tested local SHA-256 after release;
- normal users cannot open `/v13`;
- admin can use `Stable App` as a fallback;
- LINE admin status, rich menu, task freshness, and allowance pass;
- database backup task last result is 0 and a new backup validates;
- account counts and content summaries did not change during read-only checks.

Last reviewed: 12 August 2026, Asia/Bangkok.
