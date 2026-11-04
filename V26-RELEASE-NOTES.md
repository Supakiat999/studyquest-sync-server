# StudyQuest v26 release candidate

Prepared from `080bfe9e03a9efe736ab3d7c87c12200403c4138` on 4 November 2026.

## User-visible changes

- Compact date toolbar: one row on wide screens, subtle separators, inline labels, and wrapping on smaller screens.
- Applied date summaries, custom-day Apply/Enter, separate range drafts, Previous days dropdown, and the existing saved-future-task mode.
- Earlier unfinished tasks retain original dates and gain Edit, Assign and Delete actions plus a drag handle. Dropping onto a day uses the normal save/Undo flow, preserves multi-day spans, and moves only the selected repeating occurrence.

## Controlled routing

- Default behavior remains v15. No environment configuration is changed by this commit.
- The initial admin-only stage kept `STUDYQUEST_MAIN_VERSION=15` with `STUDYQUEST_V26_ACCESS=canary`.
- The owner then explicitly requested opt-in access for other signed-in users through `/26`. Set `STUDYQUEST_V26_ACCESS=all` for that opt-in while retaining `STUDYQUEST_MAIN_VERSION=15`.
- Changing the default homepage to v26 still requires a separate owner decision after trial review. This opt-in update does not approve that default change.
- Configuring main v26 while v26 access is off or canary safely retains v15 as the effective default.
- Existing authentication, device-token restrictions, stable/recovery routes, database schema, account storage and save functions are retained. No migration is required.

## Validation

`npm run check` retains the older release checks. `npm run check:v26` checks syntax, hosted hashes and routing. `npm run test:v26` runs synthetic hosted access, toolbar, task-action, continuity, PostgreSQL, save-failure and recovery tests. Test only with isolated fixtures and no production credentials. Desktop Chrome and the project test dependencies must be available.

## Release and rollback

Before either production stage, preserve pending device edits, verify the current deployment/configuration, create a fresh encrypted backup, and rehearse restoration locally. Never import a laptop working copy automatically.

After owner approval, deploy with main still v15 and observe availability for 24 hours. The owner-authorized `/26` opt-in expands access to signed-in users while preserving the v15 default. Watch lightweight availability every five minutes, and review saving/access problems without generating artificial production edits. Keep both saved copies untouched where recovery remains pending. Present results and seek a separate owner decision before changing the default homepage.

On a confirmed regression, restore the captured previous routing/configuration and deployment. Do not automatically restore the database: retain newer user edits, pending mutations, revisions and recovery copies. Keep `/v15` and existing stable/recovery links available.
## Opt-in access update

Signed-in users may open /26 as an alias for /v26 when server v26 access is set to all. The normal homepage remains v15. The alias uses the same session, per-account data and device-token rejection as the existing v26 route; it does not import or merge saved copies.
