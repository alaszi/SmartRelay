# SmartRelay — Claude Working Instructions

## About this project

SmartRelay is a general-purpose, location-agnostic relay platform built around two reference modules:

1. **Regional Alert Hub** — collects environmental data (weather, infrastructure status, etc.) for a configured location and notifies subscribers when something matters.
2. **CMMS-lite** — lightweight maintenance scheduling and reminders for small operations.

The architecture is deliberately generic. Nothing in the core system should assume a specific country, language, or region. Every concrete deployment (location, language of outbound messages, notification channels) is **configuration**, not code. The current live instance happens to be configured for Gyergyócsomafalva, Romania — that is one configuration among many, not a constraint baked into the system.

New data sources = new `CollectorInterface` implementations. New notification channels = new `NotifierInterface` implementations. New orchestration logic = new classes implementing `ServiceInterface`. Core services must never need to change just because a new module is added.

---

## Tech stack

- PHP 8.1+ (PSR-4 autoloading, strict types everywhere)
- PHPUnit 10 (tests are mandatory for every change)
- MySQL (future persistent storage)
- GitHub Actions (daily automation)
- Telegram Bot API (current notification channel; others may be added)
- Ubuntu/Nginx server

All code, comments, commit messages, and user-facing strings are written in **English** by default. A specific deployment may localize its own copy of user-facing strings (e.g. translated alert templates), but the shared/template code stays in English so it remains usable by any future deployment, in any language or region.

---

## Architecture rules

### 1. Interface-first design
Every new module implements an existing interface (`CollectorInterface`, `NotifierInterface`, `ServiceInterface`). If the interface doesn't fit, open a PR to extend the interface — don't work around it.

### 2. No hardcoded locality
Never hardcode a place name, coordinate, language string, or region-specific assumption directly into logic. Locations, thresholds, and channel targets always come through `Config::get()`. A class may ship sensible *default* values (for convenience in the absence of configuration), but the class itself must work correctly for any location or language if configured to do so.

### 3. Backward compatibility
Never make a breaking change to an existing public method signature. If a change is required: add a new method, mark the old one `@deprecated` in a docblock, and open a PR — don't silently break existing callers.

---

## Code quality rules

- `declare(strict_types=1)` is mandatory in every PHP file
- Type hints (parameters and return types) are mandatory everywhere
- Docblocks only where the type signature alone doesn't explain the "why"
- Every service action must be logged through the `Logger` class
- All user-facing strings default to English; never hardcode a non-English string into shared/template code

---

## Testing rules (MANDATORY)

### Before any change is committed, Claude must:
1. Run the existing test suite: `composer test`
2. Add a new unit test for any new code — file name `{ClassName}Test.php` in the matching `tests/Unit/` subdirectory
3. Every public method must have test coverage
4. Use mocks for external dependencies (API calls, filesystem, database) — no real network calls in unit tests

### Never deploy:
- Code with failing tests
- Untested public methods
- Hardcoded API keys or credentials
- TODO comments in production code
- Hardcoded locality assumptions in shared/template code (see Architecture rule #2)

---

## Peer review rules

Claude performs a self-review on its own code before committing:

**Checklist before every commit:**
- [ ] Is this backward compatible?
- [ ] Is there a test for it?
- [ ] Do all tests pass?
- [ ] Does it read configuration via `Config::get()` instead of hardcoding values?
- [ ] Does it log at the appropriate level?
- [ ] Does it fulfill its interface's contract?
- [ ] Could this break any existing functionality?

If any answer is "no" — fix it before committing, not after.

---

## Daily growth directive

Beyond fixing what's broken, the daily run should also look for **one small, well-scoped addition** to make the system more capable — a new generic collector, a new generic notifier, a small CMMS feature, a generalization of something that's currently too specific to one deployment, etc.

Rules for daily additions:
- Must be **additive only** — it must not change the behavior of existing, working features
- Must follow an existing interface, or open a PR if a new interface is genuinely needed
- Must ship with full unit test coverage
- If it only adds new files/classes without touching any existing public contract → safe to self-merge after tests pass
- If it requires modifying an existing interface or public method signature → open a PR instead of self-merging, and explain why the change is needed
- Prefer generalizing something Harghita/Gyergyó-specific into a configurable, reusable pattern over adding something narrowly specific to one deployment
- Note what was added in the day's summary (GitHub Actions log), so there's a clear trail of what changed and why

One thoughtful, tested addition per day beats several rushed ones. If nothing safe and well-scoped comes to mind on a given day, it's fine to do maintenance only.

---

## What Claude may do autonomously (auto-merge allowed)

- Fix a parser when an external source changes its data format
- Generate or update alert/notification content templates
- Add or extend unit tests
- Document configuration keys
- Tune log levels
- Update `.env.example` (placeholders only, never real values)
- Add a new Collector/Notifier module that doesn't touch existing interfaces
- Generalize an existing Harghita-specific piece of logic into a configurable pattern (without changing its current configured behavior)

## What REQUIRES a PR + human approval

- Any interface modification
- Database schema changes
- Changes to notification-sending core logic
- Any new external API integration
- Deployment script changes
- Anything with security implications

---

## Daily automation cycle

Every day at 03:00 server time:

1. `composer test` — if anything is already broken, fix that first
2. Check data source availability
3. Fix any broken parsers (with accompanying tests)
4. Look for one safe, well-scoped addition per the Daily growth directive above
5. Generate/update alert content as needed
6. Re-run tests — only commit if everything is green
7. Write a summary of what was done (GitHub Actions log)

---

## Project structure

```
src/
  Core/           - Config, Logger, ServiceInterface (stable, rarely changes)
  Collectors/     - Data collectors (CollectorInterface implementations)
  Processors/     - Data processors (future)
  Notifiers/      - Notification channels (TelegramNotifier, etc.)
  Services/       - Orchestrators (AlertService, MaintenanceService, LandingPageData)
tests/
  Unit/           - Unit tests (mocked, no real network calls)
  Integration/    - Integration tests (real external calls, skipped in CI)
config/
  equipment.json  - CMMS equipment list
public/
  index.php       - Public landing page
```
