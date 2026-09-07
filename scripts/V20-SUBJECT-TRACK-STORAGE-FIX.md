# v20 Subject Track recovery storage fix

The released v20 page requested version 2 of the shared browser recovery database.
Users who already had version 3 (or later) received `VersionError` when enabling
Subject Track. The error is reproduced with the original release in a fresh,
synthetic browser context.

The v20 opener now accepts the existing version. If a required store or username
index is missing, it adds only that structure in a higher schema version, leaving
existing records and unknown stores intact. It closes connections on version
changes, limits retries, and reports blocked or timed-out opens. A late upgrade
is aborted after an attempt has failed. No database deletion or storage clearing
is used.

Subject Track reads its safety backup back and verifies its account and complete
state before enabling. The setup controls show a busy state during activation;
failed attempts retain the stage draft and allow retry. Concurrent account or
state changes during backup abort activation before an active-copy write.
Storage errors give a concrete next step. The existing durable save, outbox,
account scoping, cloud revision protection, and recovery retention policy remain
in use. Only v20 application artifacts change; the server, other app versions,
and shared recovery modules retain their original bytes.

## Validation

- `npm run check`: full existing hosted release suite passed.
- `node ../scripts/test-v20-local.js`: local v20 suite passed after applying the
  same targeted fixes to the local HTML and feature module.
- `npm run test:v20:storage`: 20 real-browser synthetic cases passed separately
  in Chrome/Chromium and Playwright WebKit 26.5.
- `node scripts/test-v20-subject-track-storage.js --baseline`: reproduced the
  original version error against the base release before committing the fix.

The browser suite requires Playwright available through Node module resolution
(an installed package or `NODE_PATH`). It defaults to installed Chrome. Set
`BROWSER_ENGINE=webkit` and, if needed, `PLAYWRIGHT_BROWSERS_PATH` to use an
installed Playwright WebKit build. `TEST_SCREENSHOT_DIR` optionally captures
synthetic setup screenshots. No live credentials, cloud writes, or existing
browser profiles are used by the suite.

Coverage includes new databases; versions 1, 2, 3 and 7; incomplete schemas;
unknown-store and other-account preservation; concurrent opens; blocked and late
upgrades; denied/unavailable storage; quota; transaction abort; failed backup
readback; timeout; concurrent edits/account changes; repeated activation; stage
edits; durable outbox and offline reload; full browser mirror fallback; and
390/820/1100-pixel layouts. The storage and feature functions are extracted from
the actual v20 artifacts; the fixture supplies the surrounding app save bridge.
This is not a live account sync or physical iPad/LINE browser test.

## Release and rollback

An encrypted all-account database backup was created and decrypted/validated
before release, with a second encrypted copy verified by checksum. Private
backups and screenshots are excluded from Git. No production account record is
edited to test this fix.

After deployment, verify `/api/health`, the exact v20 HTML hash from
`/api/version?version=20`, and the served v20 feature module hash. v20 access
remains `all`, main version remains `15`, and the save-safety guard remains
enabled. Previously loaded pages must be reopened/reloaded to receive the fix.

If deployment is unhealthy, redeploy the preceding commit. If the new v20 flow
fails, use the existing v20 access switch to pause v20 while investigating;
rolling back the HTML alone reintroduces the original version error. Do not
restore the cloud database or clear browser storage as a rollback step.
