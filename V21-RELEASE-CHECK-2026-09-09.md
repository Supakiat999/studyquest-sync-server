# v21 route release checks — 2026-09-09

Requested scope: authenticated `/v21` for all existing users. Keep `/` on its
existing version (15), retain all older routes, and exclude v22. No SQL migration.

## Fixes found during the preflight

- Include the complete v21 account namespace in sync equality and recovery
  comparison. Previously a quick-note-only change could clear its outbox
  without uploading, because the legacy comparison omitted the new namespace.
- Keep view-only navigation local: no account revision or cloud write.
- Return to `/v21` after sign-in and expired sessions, without modifying the
  stored legacy login page or login responses for other versions.
- Retry pending uploads with bounded 2–60 second backoff through existing
  revision/hash/mutation checks. Stop retries for conflicts, login, storage,
  or size problems.
- Resume a previously committed device mutation after reauthentication only
  when its base revision/hash matches a freshly read account copy. This is
  not an automatic merge or a newly authorized edit.
- Remove duplicate object keys that overrode the intended authoritative-device
  flag in the generated hosted build.

## Evidence

- `npm run check` passes (rerun after the final generated build before deploy).
- Hosted browser flows pass in Chromium and WebKit: note-only and course
  uploads, device-local navigation, second-device reload, offline reconnect,
  interrupted upload, expired-session reload, retained form inputs, and phone,
  tablet, and desktop widths. Fixtures use synthetic data only.
- Existing database compatibility suite passed 51 cases; v21 is now added to
  that suite for a final combined run.
- Fresh read-only production backup: two encrypted copies verified identical;
  decryption, plaintext checksum, and table counts verified. Existing backups
  untouched. Backup paths and secrets are deliberately excluded from this file.
- Production was observed at commit `e8fc55ea66fa8275327b863648faa36bfbcb427c`,
  main version 15, with v21 not yet deployed at the start of this check.

## Remaining release gates

- Verify the final deployed page and all six assets against this checkout.
- Dedicated QA account and physical iPad/LINE offline/reconnect/reopen check.
- Only then set `STUDYQUEST_V21_ACCESS=all`. Leave the main-version setting at
  its existing value, 15. Do not promote v21 to `/` for this request.
- Observe save acknowledgements and errors after release.

Rollback: set v21 access off and keep main version 15. Do not clear device
storage, delete records, or restore the database as routine rollback.
