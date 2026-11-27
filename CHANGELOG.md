# Changelog

All notable changes to `antigravity-community-marketplace` will be documented in this file.

## [1.0.3] - 2026-11-27

### Improved
- **Collapsible Compact Filter Bar:** Moves category, surface, risk, credential, and sort controls into an expandable filter drawer with an active filter count badge and quick reset, keeping plugin cards immediately visible at the top of the sidebar.
- **Plugin Icons & Monogram Fallbacks:** Displays plugin and author icons across marketplace cards and detail drawer headers with clean two-letter monogram badges when no icon image is present.
- **Direct Details & Audit Navigation:** Adds dedicated Details and Audit actions on every plugin card along with hover tooltips and expandable descriptions.
- **Clearer Security Context & Tooltips:** Adds helpful tooltips across controls, risk tiers, and capability badges, and enriches security scan findings with plain-language capability context and clean source-inspection guidance.
- **Focused Collision Warnings:** Highlights genuine slash command, MCP server, and custom agent conflicts while allowing multiple plugins to subscribe to standard Antigravity lifecycle events seamlessly.
- **Version-Aware Plugin Tracking:** Compares full semantic versions (including prerelease tags) so locally installed plugins ahead of the catalog release display clear local-ahead status badges and accurate update counts.
- **Explicit Downgrade Confirmation:** Provides an optional registry adoption action with a clear version comparison and confirmation notice inside the security audit drawer when adopting an older catalog release over a newer local installation.

## [1.0.2] - 2026-11-27

### Added
- **Dedicated Sidebar Panel Integration:** Community Plugins now registers as a native sidebar view in the Google Antigravity App, syncing automatically with your active workspace and editor theme.
- **Responsive Compact Layout:** Adapts header controls, filters, plugin cards, and audit views cleanly to narrow sidebar panel widths.

## [1.0.1] - 2026-11-27

### Added
- **One-Command Installer & Setup:** Install and configure the Community Plugin Marketplace directly from your terminal with automated global or project-level setup and clean uninstallation support.
- **Ready-to-Use Bundled Sidebar Interface:** Ships with a pre-built sidebar interface right out of the box for instant startup with no extra build steps required.

## [1.0.0] - 2026-11-27

### Added
- **Sidebar Community Plugin Marketplace:** Browse, search, filter, favorite, and organize community-made Google Antigravity App plugins directly from the sidebar.
- **Signed Registry & Integrity Verification:** Verifies the community catalog and emergency denylist with digital signatures and immutable commit pinning before installing or updating plugins.
- **Security Audit Drawer & Permission Diffs:** Review security findings, risk tiers, and credential requirements prior to installation, and inspect newly added permissions before applying updates.
- **Global & Project-Scoped Management:** Install plugins globally or per project, pause plugins non-destructively by toggling them on or off, and uninstall cleanly.
- **Local Plugin Discovery & Collision Detection:** Automatically recognizes manually installed plugins for update tracking and warns about conflicting commands, servers, agents, or hooks.
- **Runtime & Platform Pre-Flight Checks:** Verifies required local runtimes and flags platform compatibility warnings before installing plugins with local servers or lifecycle hooks.
