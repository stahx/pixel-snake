# Changelog

## v2.4.0-beta — 2026-09-08 — Refresh after a long hiatus

This project sat mostly untouched for a few months. This round picked it
back up: fixed a handful of long-standing bugs, tuned the fog-of-war /
camera zoom system, and cleaned up repo housekeeping (PR template,
CODEOWNERS, branch protection on `main`).

### Fixed
- Boost sound would loop non-stop when holding boost at 0 points, instead
  of only playing once (PR #3)
- Snake growth would freeze permanently once size crossed a threshold,
  even as points kept climbing — replaced with a proper stepped-growth
  formula capped at a max size (PR #6)
- Point (food) collision checks scanned every point on the map per player
  per tick instead of using the existing spatial grid — ~2.9x faster (PR #5)
- The border-glow gradient on the world-wrap edges was rebuilt from
  scratch every animation frame instead of being cached (PR #5)

### Changed
- Fog-of-war vision radius now scales with snake size instead of being a
  fixed value for every player — small snakes see less, bigger snakes see
  more, tuned over several passes based on live testing (PR #6)
- Camera zoom is now dynamic, scaling with vision radius, with a hard cap
  so it can never show more than a quarter of the map's area regardless of
  snake size (PR #6)
- Added a fog-of-war vignette so entities fade out near the edge of vision
  instead of abruptly popping in/out (PR #6)
- Browser page-zoom (ctrl+wheel / pinch) is now blocked, since it could be
  used to see further than the intended vision radius (PR #6)
- Camera zoom fit tightened further after live feedback that the map was
  still showing more than intended at low-mid snake size (PR #8)
- Dev server port is now configurable via `apps/backend/.env` (see
  `.env.example`), defaulting to 3030 (PR #4)

### Added
- App favicon and tab icon, dropped the redundant on-screen title since
  the browser tab already shows it (PR #1)
- A second mute toggle for sound effects, separate from the music toggle
  (PR #3)
- PR template and `CODEOWNERS` (PR #2)
- Branch protection on `main` — changes now go through a PR

### Docs
- Refreshed the README: accurate setup/run commands (this is a pnpm
  workspace), the real default port, and a project-structure overview,
  while keeping the original "made in school for fun" note (PR #7)
