# Changelog

All notable changes to `antigravity-community-marketplace` will be documented in this file.

## [1.0.0] - 2026-11-27

### Added
- **Sidebar Community Plugin Marketplace:** Browse, search, filter, favorite, and organize community-made Google Antigravity App plugins directly from the sidebar.
- **Signed Registry & Integrity Verification:** Verifies the community catalog and emergency denylist with digital signatures and immutable commit pinning before installing or updating plugins.
- **Security Audit Drawer & Permission Diffs:** Review security findings, risk tiers, and credential requirements prior to installation, and inspect newly added permissions before applying updates.
- **Global & Project-Scoped Management:** Install plugins globally or per project, pause plugins non-destructively by toggling them on or off, and uninstall cleanly.
- **Local Plugin Discovery & Collision Detection:** Automatically recognizes manually installed plugins for update tracking and warns about conflicting commands, servers, agents, or hooks.
- **Runtime & Platform Pre-Flight Checks:** Verifies required local runtimes and flags platform compatibility warnings before installing plugins with local servers or lifecycle hooks.
