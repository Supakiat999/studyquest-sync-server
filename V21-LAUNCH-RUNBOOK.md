# StudyQuest v21 launch runbook

Making v21 the default app for all signed-in users. Follow the gates in order.
Any gate that fails stops the launch; go to [Rollback](#rollback).

The engineering work for gates 1–3 is in this checkout. Gates 4–7 are operator
steps: they deploy to the live service, touch real account backups, and change
what every signed-in user sees, so they are performed by you, not automatically.

## What changed

| Area | Before | Now |
| --- | --- | --- |
| Hosted v21 | Did not exist; v21 was laptop-only | `/v21` and `/claudever21.html`, authenticated and access-gated |
| Manual courses | Device IndexedDB only | Account state, namespace `_studyquestV21` |
| Quick note | Browser `localStorage` only | Account state; the browser key is now a device cache |
| Subject Track setting | Laptop-local | Account state (the `weeklyV20` stage overlay is unchanged) |
| Recovery | Three-step wizard with a confirmation checkbox | One screen, one labelled Apply |
| Save status | Mixed local wording | `Saving…` / `Saved on this device · upload pending` / `Saved to your account` / `Needs attention`, with the last confirmed online save time |
| Autosave history | v21 laptop build disabled pruning | 20 copies within the existing 40 MB budget; protected migration and recovery archives are never pruned |

No SQL schema change. `/api/v2/state`, account authentication, revision and hash
checks, mutation ids, and conflict storage are reused as they are.

## Environment variables

| Variable | Values | Meaning |
| --- | --- | --- |
| `STUDYQUEST_V21_ACCESS` | `off` (default), `canary`, `all` | Who may open v21 |
| `STUDYQUEST_V21_CANARY_USERS` | comma-separated usernames | Added to admin when the mode is `canary` |
| `STUDYQUEST_MAIN_VERSION` | `15` (default), `19`, `21` | Which version `/` serves |

`off` closes v21 for everyone including admin. `canary` is admin plus the
allowlist and nobody else. Setting `STUDYQUEST_MAIN_VERSION=21` while access is
`canary` is safe: anyone outside the allowlist falls through to the previous
default rather than losing an app.

## Gate 1 — automated suites

```bash
npm run check
```

Runs the hosted, v21, database-compatibility, recovery, and sync suites,
including `test-v21-hosted-release.js` and `test-v21-account-store.js`.

Known environment limits in a bare checkout: `test-v19-rollout-monitor.js` needs
`pg`, and the browser suites need Playwright. Run `npm install` first, then:

```bash
npm i -D playwright && npx playwright install chromium webkit
```

## Gate 2 — hosted flows on synthetic accounts

```bash
npm run test:v21:flows
```

Serves the built page against an in-process stand-in for `/api/v2/state` that
enforces the real revision, hash, and mutation-id rules. Covers manual courses,
the quick note, Subject Track, Undo, duplicate submissions, offline edits,
interrupted uploads, expired sessions, concurrent tabs and devices, older
clients, failed readback, and reopening on a second device — with database
acknowledgement asserted, not assumed. It touches no real account.

## Gate 3 — interaction and layout review

Covered by the same run: routine actions raise no confirmation dialog, recovery
fits one screen, a refused action keeps what was typed, and Chromium and WebKit
are checked at phone, tablet, and desktop widths.

## Gate 4 — backups, then deploy behind canary

**Operator step.**

1. Create a fresh encrypted all-account backup and a second verified copy:

   ```bash
   node scripts/database-backup.js
   ```

   Confirm both copies restore-check before continuing. Do not proceed on a
   backup you have not verified.

2. Deploy this branch with the default unchanged:

   ```text
   STUDYQUEST_V21_ACCESS=canary
   STUDYQUEST_V21_CANARY_USERS=<your QA account>
   STUDYQUEST_MAIN_VERSION=15
   ```

3. Verify the deploy is the build you tested:

   ```bash
   node scripts/verify-v21-deployment.js https://your-service.example.com
   ```

   This compares the deployed page and every feature layer against this
   checkout, confirms `/v21` requires a session and never redirects to a laptop
   address, confirms database health, and confirms `/api/v2/state` still refuses
   anonymous reads. A mismatch means the deploy is stale or mixed — stop.

## Gate 5 — QA account and the physical iPad/LINE check

**Operator step. This gate is a hard requirement for the public switch.**

Using the dedicated QA account on `/v21`:

1. Save, reopen, and confirm the change on a second device.
2. On the physical iPad, through LINE:
   - edit while offline,
   - reconnect,
   - reopen the app,
   - confirm the changes are still there and the status reaches
     `Saved to your account`.

Do not substitute a simulator, a desktop browser at a narrow width, or the
synthetic flows in gate 2. If this check does not pass on the real device, the
launch stops here.

## Gate 6 — switch the default

**Operator step.**

```text
STUDYQUEST_V21_ACCESS=all
STUDYQUEST_MAIN_VERSION=21
```

Apply `STUDYQUEST_V21_ACCESS=all` first and confirm it, then set the main
version. After the deploy settles:

```bash
node scripts/verify-v21-deployment.js https://your-service.example.com
```

Confirm `v21AccessMode: "all"`, `mainVersion: "21"`, `v21Main: true`, and a
deployed hash matching this checkout. Then sign in as the QA account, make one
edit, and confirm it reaches `Saved to your account`.

Observe for 15 minutes. Watch for save acknowledgements, authentication
failures, database errors, and any recovery prompt appearing for a user who did
not ask for one.

## Gate 7 — rollback

**Operator step.** If save integrity, account isolation, or deployment checks
fail:

```text
STUDYQUEST_MAIN_VERSION=15
STUDYQUEST_V21_ACCESS=off
```

That restores the previous default immediately. It is the whole rollback.

Do **not**, as routine rollback:

- clear browser storage on any device — pending device data lives there and the
  outbox will still upload it once v21 is reachable again;
- restore the database — v21 fields are additive, and an older client cannot
  erase them (`preserveV21Namespace` keeps the namespace when a client omits
  it), so a restore would discard good account data to solve nothing.

Restore the database only if you have confirmed actual account data loss, and
only from a backup verified in gate 4.

## Rollback

See gate 7. Two environment variables, no data operations.
