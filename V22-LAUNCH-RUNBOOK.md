# StudyQuest v22 Hosted Launch Runbook

This runbook publishes the separate signed-in `/v22` route without replacing
the homepage or `/v21`. Stop at the first failed gate.

## Release identity

| Item | Value |
| --- | --- |
| Route | `/v22` |
| Alias | `/claudever22.html` |
| Access | Signed-in accounts only |
| Main selector | `STUDYQUEST_MAIN_VERSION=15` remains unchanged |
| Release hash | `d78679244708d32950f444cc5b22765e3c6ed3412015fea175684ce11ce32a17` |
| Local release backup | `backups/public-v22-rollout-20260912144936` in the parent workspace |
| Database backups | `studyquest-2026-09-12T02-38-18-735Z.sqbackup` and `studyquest-2026-09-12T09-27-13-632Z.sqbackup`; both validated with 3 accounts and checksum/decryption readback |

## Data model and save behavior

- Existing shared v21 records remain in `_studyquestV21`.
- V22 subtasks are additive in `_studyquestV22.subtasks`; there is no SQL
  migration or new public save endpoint.
- `/api/v2/state` keeps its revision, base-hash, mutation-id, readback, and
  conflict-copy protections. Older clients that omit `_studyquestV22` cannot
  erase it.
- Device recovery/outbox is written first. The UI reports **Saved to your
  account** only after the authenticated server acknowledges the revision.
- The admin laptop import is file-based, read-only during preview, additive on
  approval, account-wins on conflicts, and never deletes the selected laptop
  export.

## Gate 1 — focused local verification

Run from this checkout:

```powershell
node --check server.js
node --check lib/state-safety.js
node scripts/check-html.js public/claudever22.html
npm.cmd run test:v22
```

Also run the existing v21 hosted/account-store checks. These are focused
regressions for the shared state flow; do not skip them because v22 uses the
same endpoint.

```powershell
npm.cmd run test:v21
```

Record the results and confirm `public/v21-version.json` and
`public/claudever21.html` are unchanged before continuing.

## Gate 2 — verified backups and clean release

1. Create two encrypted, restore-checked all-account database backups with the
   existing `scripts/database-backup.js` procedure. Record both identifiers
   above. Do not continue if coverage, checksum, or decryption verification
   fails.
2. Export the laptop v22 bundle separately. Review counts/differences before
   using the admin import panel; do not auto-import it during deployment.
3. Confirm the release checkout contains only intended tracked v22 changes.
   The existing untracked debug scripts must not be committed or deployed.
4. Confirm the manifest hash above matches `/v22-version.json` and every v22
   asset hash.

## Gate 3 — canary

Set the Render runtime values without changing the main selector:

```text
STUDYQUEST_V22_ACCESS=canary
STUDYQUEST_V22_CANARY_USERS=<dedicated QA username>
STUDYQUEST_MAIN_VERSION=15
```

Verify the deployed checkout and then test with `admin` and the dedicated QA
account on separate devices:

- anonymous `/v22` redirects to login;
- an authenticated canary account can open `/v22`;
- a non-canary account is redirected to the stable app;
- v22 assets and `/v22-version.json` match the release hash;
- manual courses, notes, Subject Track, and subtasks save/reload correctly;
- offline edits remain in device recovery and later reach the account;
- repeating occurrences retain independent checklists;
- v21 data remains present and account isolation holds;
- imported laptop data is previewed and approved only after the extra backup;
- the save status reaches **Saved to your account** only after acknowledgement.

## Gate 4 — public enablement

After the canary passes, change only:

```text
STUDYQUEST_V22_ACCESS=all
```

Keep `STUDYQUEST_MAIN_VERSION=15`. Verify `/v22` with an ordinary signed-in
account and observe at least 15 minutes for failed saves, authentication
errors, revision conflicts, state-size errors, recovery prompts, database
errors, or cross-account data.

## Rollback

Set:

```text
STUDYQUEST_V22_ACCESS=off
```

This hides `/v22` without clearing browser data, device outboxes, account
state, immutable history, or backups. A database restore is reserved for
confirmed corruption after reviewing both verified backups.

## Verification record

The code-side focused checks completed for this release candidate:

- hosted route/access/manifest/namespace-preservation checks passed;
- account-backed manual-course and subtask isolation/stale-write checks passed;
- v22 syntax and HTML parsing passed;
- database backup identifiers, canary account, and public observation window
  must be recorded by the deployment operator after the hosted gates run.
