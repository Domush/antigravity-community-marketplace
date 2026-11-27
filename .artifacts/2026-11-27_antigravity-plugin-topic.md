# Plan: Add `antigravity-plugin` Discovery Topic

**Date:** 2026-11-27  
**Target Repositories:**
- `c:\GitHub\antigravity-plugin-registry` (crawler, parser, Issue-Ops workflow, web portal copy, tests, README)
- `c:\GitHub\antigravity-community-marketplace` (README submission note)

## Goal
Add `antigravity-plugin` alongside `agy-plugin` as a supported GitHub repository discovery topic/tag in the plugin registry crawler and submission workflow, while leaving the existing release-vs-HEAD commit resolution logic (`resolveTargetRelease`) completely unchanged.

## Implementation Steps
1. **`c:\GitHub\antigravity-plugin-registry\scripts\lib\github-client.mjs`**
   - Export `DEFAULT_DISCOVERY_TOPICS = ["agy-plugin", "antigravity-plugin"]`.
   - Replace single-string `topic` configuration in `createGitHubClient` with validated, deduplicated `topics` array (fail-fast if empty).
   - Update `discoverRepositories` and `searchRange` to query each configured discovery topic and merge/deduplicate repositories in the collected `Map`.
   - Leave `resolveTargetRelease` untouched.
2. **`c:\GitHub\antigravity-plugin-registry\scripts\crawl.mjs` & `scripts/lib/plugin-parser.mjs`**
   - Update `CONFIG.topics = ["agy-plugin", "antigravity-plugin"]` in `crawl.mjs` and pass `topics: CONFIG.topics` to `createGitHubClient` and `validateAndParsePlugin`.
   - Update `validateAndParsePlugin` to accept `topics = ["agy-plugin", "antigravity-plugin"]` and exclude all configured discovery topics (case-insensitively) plus `agy-cat-*` when building `tags`.
3. **Workflow, Issue Template, Web Portal, and Documentation**
   - Update `.github/workflows/issue-ops-submit.yml` and `.github/ISSUE_TEMPLATE/submit-plugin.yml` to accept either `agy-plugin` or `antigravity-plugin`.
   - Update `site/index.html`, `antigravity-plugin-registry/README.md`, and `antigravity-community-marketplace/README.md` to document both `agy-plugin` and `antigravity-plugin`.
4. **Tests**
   - Add `tests/github-client.test.mjs` covering multi-topic discovery & deduplication, fail-fast topic validation, and unchanged `resolveTargetRelease` behavior.
   - Add a fixture test in `tests/registry-fixtures.test.mjs` verifying both `agy-plugin` and `antigravity-plugin` are excluded from `parsed.tags`.

## Edge Cases
- Repositories tagged with both `agy-plugin` and `antigravity-plugin` must appear only once in `discoverRepositories()` results.
- Topic matching in `issue-ops-submit.yml` and tag filtering in `plugin-parser.mjs` should handle case normalization cleanly.
- Rate-limit pacing (2.2s delay) must apply between multiple topic search requests in production, with a configurable `searchDelayMs` option so unit tests run quickly without real sleeps.

## Verification Strategy
- Run `npm test` in `c:\GitHub\antigravity-plugin-registry` and save output to `Logs/`.
- Run `npm test` in `c:\GitHub\antigravity-community-marketplace` and save output to `Logs/`.
- Run `node "C:\Users\domus\.gemini\config\plugins\agent-team\scripts\audit-gate.js"` on all modified/created source and test files.
