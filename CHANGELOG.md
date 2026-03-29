# Changelog

## [1.2.1] — 2026-03-29

### Changed
- README expanded with setup instructions for Cursor, Windsurf, Zed, Continue.dev, and custom MCP integrations
- Clarified that the server implements the open MCP 1.0 stdio standard (not Claude-exclusive)
- Removed `POLYFORGE_API_URL` from quick-start snippets (defaults to `https://api.polyforge.app`)

## [1.2.0] — 2026-03-29

### Added
- `get_strategy_events` tool — polls recent execution events for a running strategy; accepts `id`, `after_timestamp` (Unix ms cursor), and `limit`; returns a `{ events, nextAfterTimestamp }` batch for stateless follow-up calls
- Total tools: 23

## [1.0.1] — 2026-03-28

### Fixed
- README tool count corrected from 20 to 22

## [1.1.0] — 2026-03-27

### Added
- `place_order` tool — place direct buy/sell orders on prediction markets
- `cancel_order` tool — cancel pending or live orders
- Total tools: 22

## [1.0.0] — 2026-03-27

### Added
- Initial release extracted from PolyForge monorepo
- 20 tools: markets, strategies, portfolio, orders, whale feed, news signals, webhooks, AI query
- Stdio transport for Claude Desktop and Claude Code
