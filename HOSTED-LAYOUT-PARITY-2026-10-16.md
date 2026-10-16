# Hosted v24/v25 laptop layout correction

The previous acceptance compared v24 with v25 separately on each platform.
That missed a mismatch between the laptop and hosted presentations. Hosted
pages installed a sidebar interface that changed fonts, spacing, task rows
and the XP header. The requested reference is the laptop v25 page.

## Changes

- Both hosted pages now use the laptop's base styles and horizontal navigation.
- Remove the sidebar installer and its layout stylesheet from these pages.
- Keep dialog accessibility, keyboard trapping, busy recovery protections and
  input labels in a small, separate presentation helper.
- Retain hosted inline-title styles under their existing class names.
- Correct the hosted header badge to its actual version.
- Update both HTML hashes and manifests. Original shared assets stay unchanged.

The server, authentication, account namespaces, save/recovery/outbox code,
transfer logic and date/subtask assets are unchanged. Laptop pages, v15 and
older fallback artifacts are unchanged. No migration or data replacement.

## Verification

- Direct laptop v25 versus hosted v24 and v25 comparison with identical synthetic
  records, viewport and navigation anchor. Header, horizontal tabs, XP/stats,
  command center, task rows and inline titles match within one pixel.
- Visual inspection of unobscured screenshots; phone/tablet overflow checks
  and section navigation pass. External font requests are blocked in isolated
  tests; both targets use the same fallback and declare the same font families.
- 100 v24 and 100 v25 reproducible save-failure sequences pass, with complete
  state hash checks, forced restarts and mutation-specific pending-work tests.
- Hosted editing, metadata races, hidden-tab retries, isolated PostgreSQL,
  stale 89-to-78 incident, transaction atomicity, account isolation, access modes,
  version continuity, LINE privacy/digest and synthetic encrypted restore pass.
- Two assertions expected the removed sidebar's version label. They were
  updated to check the correct header badge and rerun successfully.
- Inline application code matches the deployed baseline after excluding the
  explicitly changed version-label function and presentation installer calls.

No synthetic records are written to production. Live checks use the existing
admin session and read-only account audits. The verified encrypted backup and
browser recovery exports remain outside Git. Main routing and rollout access
settings are retained; this correction does not expand user access.

Zero future loss is not guaranteed. Local test evidence does not itself prove
deployment or whole-month Free eligibility. Record the deployed commit and live
visual verification separately in the local rollout report.
