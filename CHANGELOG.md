# Changelog

All notable changes to `antigravity-community-marketplace` will be documented in this file.

## [1.0.8] - 2026-11-28

### Improved
- **Seamless Active Plugin Updates:** Automatically updates active plugin files in place when folders are busy and stages updates in an isolated staging area to finish automatically when you restart the Antigravity App, using clean author-and-plugin folder names and allowing pending updates to be cancelled cleanly.
- **Reliable Background Update Completion:** Launches an independent background updater using your system Node runtime that waits until all Antigravity processes exit before completing staged plugin updates, keeps sidebar and background storage unified, prevents duplicate updaters from interrupting active updates, and records diagnostic logs for troubleshooting.
- **Plugin Manager Icon & Display Name:** Updated the plugin manifest so Antigravity's Plugins view displays the Community Plugins title and icon.
- **Rich README Rendering (Images, Tables & GitHub-Flavored Markdown):** Uses a bundled Markdown renderer with strict sanitization to display README images, badges, tables, nested lists, and release notes cleanly inside the plugin details drawer.
- **Clearer Update Review & Scope Safety:** Displays all release notes since your installed version alongside permission diffs when reviewing updates, automatically closes the detail drawer after confirming an update, places a Back button in the top-left of the detail drawer with the README & Notes tab first, shows a prominent amber pending-restart notice, prevents duplicate pending updates or repeated update clicks, enforces single-scope installs with clear warnings, treats matched local plugins like standard updates, shows update actions directly in Details, and surfaces action errors inside the drawer.
- **Safer Installed Plugin Controls:** Highlights **Disable** (or **Enable** when paused) as the default card action for up-to-date installed plugins—with **Update** kept primary whenever an update is available—and moves **Uninstall** into the action dropdown menu to prevent accidental removals.

## [1.0.7] - 2026-11-27

### Added
- **Automated Release Publishing:** Added automated GitHub Release creation with changelog release notes alongside npm package publishing for tagged releases.

## [1.0.6] - 2026-11-27

### Improved
- **Streamlined Plugin Card & Header UI:** Added a custom marketplace icon and refined sidebar header, simplified upgrade buttons to `Update`, combined install/disable/uninstall actions into a contextual split button with bright `Install` and `Details` styling, replaced `Hide` with an eye icon aligned beside a larger star icon, and hid the project selector pill by default.
- **Cleaner Catalog & Installed Views:** Excluded the marketplace plugin itself from browsable and installed plugin listings so updates are handled exclusively through the dedicated marketplace update banner.

## [1.0.5] - 2026-11-27

### Improved
- **Expanded Plugin Discovery Documentation:** Updated plugin submission guidance to cover both `agy-plugin` and `antigravity-plugin` repository topics.

## [1.0.4] - 2026-11-27

### Improved
- **Instant Plugin Details & README Rendering:** Renders large and badge-rich plugin READMEs smoothly and responsively inside the details drawer, including complex links and image badges.
- **Snappy Drawer Navigation:** Keeps rapid plugin detail selections in sync so switching between plugins always displays the latest selected plugin information cleanly.

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
