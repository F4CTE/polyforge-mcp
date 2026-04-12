# Changelog

## [Unreleased]

### Security
- **Import validation**: Replace open `z.record(z.string(), z.unknown())` in `importStrategySchema` with concrete schema matching backend `ImportStrategyDto` — validates name, description, execMode, blocks, variables, canvas with type constraints and size limits; unwrap `data` wrapper so backend receives correct shape; rejects prototype pollution payloads at MCP boundary (closes #70)
- **Dependencies**: Override `hono` to >=4.12.12 and `@hono/node-server` to >=1.19.13 — fixes 6 CVEs (cookie bypass CVE-2026-39410, path traversal CVE-2026-39408, middleware bypass CVE-2026-39407, header injection GHSA-26pp-8wgv-hjvm) in transitive deps from `@modelcontextprotocol/sdk` (closes #72)
- **Input validation**: Add UUID format validation to all 15 ID-accepting tools (`get_market`, `get_strategy`, `cancel_order`, `delete_alert`, `get_backtest`, `export_strategy`, `stop_strategy`, `pause_strategy`, `resume_strategy`, `fork_strategy`, `delete_strategy`, `purchase_strategy`, `cancel_smart_order`, `get_marketplace_listing`, `get_market_sentiment`) — malformed IDs are rejected at the MCP boundary instead of forwarded to the backend (closes #48)
- **Query validation**: Add Zod schemas with bounded limits (max 100), typed numerics, and enum constraints to all 11 query-parameter tools (`list_markets`, `get_orders`, `list_backtests`, `get_whale_feed`, `get_news_signals`, `browse_marketplace`, `get_portfolio_pnl`, `list_conditional_orders`, `get_arbitrage_opportunities`, `list_strategies`, `list_smart_orders`) — prevents unbounded limit DoS and type confusion (closes #49)
- **CI**: switch from self-hosted runner to `ubuntu-latest` for `pull_request` events and add `permissions: contents: read` to restrict GITHUB_TOKEN scope (closes #69)
- **SSRF**: add hex-word IPv4-mapped IPv6 pattern matching (`::ffff:7f00:1` form) to `isPrivateIPv6()` — prevents bypass of webhook URL validation via Node.js-normalized addresses (closes #25)
- Remove `.passthrough()` from `updateStrategySchema` — prevents mass-assignment of arbitrary fields to `PATCH /strategies/:id` (closes #26, closes #37)
- Add `provideLiquiditySchema` Zod validation — enforces UUID tokenId, positive spread ≤1, positive size before forwarding to `/lp/provide` (closes #28)
- Add `startStrategySchema` Zod validation — enforces enum mode (`live`|`paper`) before forwarding to `/strategies/:id/start` (closes #28)
- Cap `retry-after` header to 60 seconds — prevents server-controlled indefinite hang DoS (closes #27)
- Use explicit field allowlist in `update_strategy` route body instead of spread operator

### Fixed
- **BREAKING**: `ai_query` tool sends `question` instead of `query` to match platform `AiQueryDto`; added optional `context` field (closes #50)
- **BREAKING**: `run_backtest` tool sends `dateRangeStart`/`dateRangeEnd`/`initialBalance` instead of `startDate`/`endDate`/`initialCapital` to match platform contract (closes #46)
- **BREAKING**: `create_webhook` tool event values changed from SCREAMING_SNAKE_CASE to dot.notation to match platform (closes #43)
- **BREAKING**: `create_strategy_from_description` tool sends `query` instead of `description` to match platform (closes #38)
- **BREAKING**: `start_strategy` tool sends uppercase `"LIVE"`/`"PAPER"` mode values to match platform (closes #41)
- **BREAKING** `callApi()`: handle 204 No Content responses — `delete_strategy` and `delete_alert` no longer crash with `SyntaxError: Unexpected end of JSON input` (closes #67)
- **BREAKING** `createWebhookSchema`: remove non-existent `secret` field (causes 400 from platform) and make `events` required to match platform DTO (closes #68)
- **BREAKING** `placeSmartOrderSchema`: add all optional TWAP/DCA/BRACKET/OCO parameters (`slices`, `intervalMinutes`, `limitPrice`, `entryPrice`, `takeProfitPrice`, `stopLossPrice`, `priceA`, `priceB`) that were silently stripped by Zod (closes #64)
- `run_backtest`: add `initialBalance` to Zod schema so it's no longer stripped (closes #61)

## [1.5.0] — 2026-04-03

### Added
- `pause_strategy` tool — pause a running strategy (closes #14)
- `resume_strategy` tool — resume a paused strategy (closes #14)
- `fork_strategy` tool — fork a strategy to create an editable copy (closes #14)
- `delete_strategy` tool — permanently delete a stopped strategy (closes #14)
- `import_strategy` tool — import a strategy from a .polyforge JSON export (closes #14)
- `redeem_position` tool — redeem winning shares after market resolution (closes #15)
- `split_position` tool — split a position into smaller positions (closes #15)
- `merge_position` tool — merge multiple positions into one (closes #15)
- `get_marketplace_listing` tool — get details of a single marketplace listing (closes #15)
- Total tools: 42

### Fixed
- `get_orders` tool: added missing `strategyId`, `from`, `to` query parameters for filtering orders by strategy and date range (closes #17)
- `browse_marketplace` tool: added missing `offset` query parameter for pagination (closes #16)

## [1.4.2] — 2026-04-03

### Fixed
- **BREAKING** `place_smart_order` Zod schema: renamed `size` to `totalSize` to match the backend API field name; added `type` enum validation (`TWAP`, `DCA`, `BRACKET`, `OCO`) (closes #13)
- **SECURITY** `update_strategy` handler: added `updateStrategySchema` Zod validation to prevent unvalidated fields from being forwarded to the backend API (closes #12)

### Security
- Remove `.passthrough()` from all 10 Zod input-validation schemas to prevent mass-assignment of arbitrary extra fields (closes #9)
- Add Zod validation schema for `get_strategy_events` handler inputs (closes #10)
- Harden webhook URL validation against SSRF: block IPv6 loopback/link-local/unique-local, IPv4-mapped IPv6, cloud metadata endpoints, carrier-grade NAT, `.local`/`.internal`/`.localhost` TLDs, URL credentials, and additional reserved ranges (closes #11)

## [1.4.1] — 2026-03-30

### Fixed
- `get_market_sentiment` response: API returns `direction` field (not `label`); updated tool description to reflect the correct field name (`direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'`)

## [1.4.0] — 2026-03-30

### Added
- `get_accuracy` tool — fetch prediction accuracy and calibration score for the authenticated user; returns Brier score, win rate, calibration buckets, and per-category breakdown
- `get_portfolio_review` tool — fetch AI-generated portfolio review with score (1–10), suggestions list, and analysis text
- `get_market_sentiment` tool — fetch aggregated news sentiment for a specific market; accepts `marketId`; returns score (−100 to +100), BULLISH / BEARISH / NEUTRAL label, and signal count
- `provide_liquidity` tool — place two-sided market-making quotes on a token; accepts `tokenId`, `spread`, `size`; returns buy and sell order IDs
- Total tools: 33

## [1.3.0] — 2026-03-30

### Added
- `get_arbitrage_opportunities` tool — scan all active markets for merge arbitrage (YES + NO < $1.00); optional `minMargin` filter
- `place_smart_order` tool — place TWAP, DCA, BRACKET, or OCO smart orders with slice/schedule parameters
- `list_smart_orders` tool — list user's smart orders including child order progress
- `cancel_smart_order` tool — cancel a pending or active smart order and all its child orders
- `browse_marketplace` tool — browse strategy marketplace listings; supports `sort`, `tag`, `limit`
- `purchase_strategy` tool — purchase a marketplace listing and receive a forked strategy copy
- Total tools: 29

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
