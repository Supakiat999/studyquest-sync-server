# Hosted v24 release

v24 derives from current hosted v21 safety code and carries the reviewed v23
interface, subtasks and v24 date controls. Older artifacts remain byte-identical.
Opening v24 never imports local subtasks or date overlays into the account.
The shared subtask namespace and legacy namespaces survive older-client saves.

Run `npm ci`, `npm run check`, `npm run test:v22`, and `npm run test:v24`.
The PostgreSQL integration test uses an isolated in-memory PGlite database and
synthetic users. It never connects to production. No schema migration is required.
Manifest hashes cover the committed HTML and every v24 asset. The server adds
the authenticated account bootstrap separately when serving HTML.

Before deployment, run the encrypted database backup wrapper and require its
decryption validation to succeed for every account. Create a new private audit
baseline; retain revisions, computed/stored hashes, counts and recovery history.
Private backup and audit files must never be committed.

1. Deploy the exact tested commit with `STUDYQUEST_V24_ACCESS=off` and
   `STUDYQUEST_MAIN_VERSION=15`. Verify commit, health, manifest and older routes.
2. Set access to `canary` and add the dedicated QA username to
   `STUDYQUEST_V24_CANARY_USERS`. Admin is included in canary automatically.
   Verify real-account read-only startup and use only QA data for deliberate edits.
   Monitor at least 15 minutes and reconcile every account change.
3. Set access to `all`; verify an ordinary signed-in account, then set
   `STUDYQUEST_MAIN_VERSION=24`. Confirm `/`, `/app.html`, explicit older links,
   `/app.html?stable=1`, logged-out redirects and recovery fallback.
4. Monitor another 15 minutes. Report completion only after all gates pass.

On unexplained record loss, unsafe writes, failed startup or broken login, set
main version to `15` and v24 access to `off`. Keep outboxes, account records and
recovery history. Database restoration requires a separate recovery review.

The committed default stays v15 and v24 access defaults off. Credentials,
invitations and account limits are unchanged. Missing credentials or a failed
backup or safety gate stop promotion.
