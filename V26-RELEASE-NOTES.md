# StudyQuest v26 release candidate

Prepared from `080bfe9e03a9efe736ab3d7c87c12200403c4138` on 4 November 2026.

## User-visible changes

- Compact date toolbar: one row on wide screens, subtle separators, inline labels, and wrapping on smaller screens.
- Applied date summaries, custom-day Apply/Enter, separate range drafts, Previous days dropdown, and the existing saved-future-task mode.
- Earlier unfinished tasks retain original dates and gain Edit, Assign and Delete actions plus a drag handle. Dropping onto a day uses the normal save/Undo flow, preserves multi-day spans, and moves only the selected repeating occurrence.

## Controlled routing

- Default behavior remains v15. No environment configuration is changed by this commit.
- Admin trial: keep `STUDYQUEST_MAIN_VERSION=15` and use `STUDYQUEST_V26_ACCESS=canary` with the existing approved canary account selection. Do not expand access during the trial.
- Public promotion requires both `STUDYQUEST_MAIN_VERSION=26` and `STUDYQUEST_V26_ACCESS=all`, applied together after the 24-hour trial and owner review.
- Configuring main v26 while v26 access is off or canary safely retains v15 as the effective default.
- Existing authentication, device-token restrictions, stable/recovery routes, database schema, account storage and save functions are retained. No migration is required.

## Validation

`npm run check` retains the older release checks. `npm run check:v26` checks syntax, hosted hashes and routing. `npm run test:v26` runs synthetic hosted access, toolbar, task-action, continuity, PostgreSQL, save-failure and recovery tests. Test only with isolated fixtures and no production credentials. Desktop Chrome and the project test dependencies must be available.

## Release and rollback

Before either production stage, preserve pending device edits, verify the current deployment/configuration, create a fresh encrypted backup, and rehearse restoration locally. Never import a laptop working copy automatically.

After owner approval, deploy this exact candidate with main still v15 and perform a 24-hour admin trial. Watch lightweight availability every five minutes, and review saving/access problems without generating artificial production edits. Notify only for actionable changes or the completed trial. Present results and seek a separate owner decision before public promotion.

On a confirmed regression, restore the captured previous routing/configuration and deployment. Do not automatically restore the database: retain newer user edits, pending mutations, revisions and recovery copies. Keep `/v15` and existing stable/recovery links available.
