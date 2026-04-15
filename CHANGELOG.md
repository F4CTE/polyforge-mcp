# Changelog

## [1.7.7] — 2026-04-15

### Fixed
- **list_markets sort enum** — remove 4 phantom values (`endDate`, `firstSeenAt`, `closing_soon`, `liquidity`), add missing `popular` sort option. (closes #103)
- **get_portfolio_pnl period enum** — remove phantom `1d` value, fix `all` → `allTime` to match platform. (closes #102)

## [1.7.6] — 2026-04-15

### Security
- Upgrade `hono` to 4.12.12+ and `@hono/node-server` to 1.19.13+ via pnpm update — fixes 6 moderate CVEs: cookie validation bypass, IP restriction bypass, path traversal in toSSG, and middleware bypass via repeated slashes (closes #100)

## [1.7.5] — 2026-04-14

### Security
- **SSE buffer cap**: `pollStrategyEvents` now enforces a 1 MB maximum buffer size — large SSE payloads abort the connection instead of exhausting memory (closes #44)
- **Startup env validation**: `POLYFORGE_API_KEY` and `POLYFORGE_API_URL` are now read once at module load and validated before `server.connect()`; missing key exits with a clear fatal error instead of failing silently per-call (closes #45)

## [1.7.4] — 2026-04-14

### Fixed
- `run_backtest`: `dateRangeStart` and `dateRangeEnd` now validated as ISO 8601 date format (`YYYY-MM-DD`) instead of accepting arbitrary strings (closes #42)

## [1.7.3] — 2026-04-14

### Fixed
- `create_conditional_order`: add missing required `tokenId`, `type`, `outcome` params and optional `trailingPct`, `expiresAt` to match platform DTO (closes #94)
- `create_strategy` / `update_strategy`: add missing block arrays, visibility, execMode, tickMs, tags, variables, canvas, and marketSlots parameters to match platform DTO (closes #95)
- `update_strategy`: fix body handler to pass all fields instead of hardcoded pick list

## [1.7.2] — 2026-04-13

### Added
- `delete_webhook` tool — delete a registered webhook endpoint (closes #57)
- `test_webhook` tool — send a test event to verify webhook delivery (closes #57)
- `list_watchlist` tool — list watched markets with prices and volume (closes #54)
- `add_to_watchlist` tool — add a market to the watchlist (closes #54)
- `remove_from_watchlist` tool — remove a market from the watchlist (closes #54)
- `get_watchlist_status` tool — check if a market is being watched (closes #54)
- `get_conditional_order` tool — get details of a specific conditional order (closes #55)
- `cancel_conditional_order` tool — cancel a pending conditional order (closes #55)

## [1.7.1] — 2026-04-13

### Fixed
- `list_markets`: add missing `sort` and `closed` query parameters from platform `MarketQueryDto` (closes #75)
- `list_strategies`: add missing `sort`, `page`, and `limit` query parameters from platform `StrategyQueryDto` (closes #79)
- `get_orders`: add missing `marketId` and `page` query parameters from platform `OrderQueryDto` (closes #76)
- `list_backtests`: add missing `status` query parameter from platform `BacktestQueryDto` (closes #74)
- `list_conditional_orders`: add missing `type` and `page` query parameters from platform `ConditionalOrderQueryDto` (closes #73)

## [1.7.0] — 2026-04-13

### Fixed
- **BREAKING** `create_strategy_from_description`: Zod schema silently stripped `marketId` — AI-generated strategies could not be bound to a market (closes #60)
- **BREAKING** `run_backtest`: removed phantom `initialBalance` field not in platform contract; added `quickMode`, `strategyBlocks`, `marketBindings` optional fields to match platform DTO (closes #23)
- **BREAKING** `create_conditional_order`: removed `tokenId`, `outcome`, `type`, `trailingPct`, `expiresAt` fields not in platform contract; schema now matches platform: `{ marketId, side, size, triggerPrice, limitPrice? }` (closes #24)
- **BREAKING** `close_position`: `size` field changed from `z.number()` to `z.string()` to match platform NumberString format for partial closes (closes #30)
- **BREAKING** `place_order`, `place_smart_order`: removed `.int()` restriction on size/totalSize — platform accepts decimal share amounts (closes #36)
- Tool definitions (inputSchema) updated to match all schema changes above

## [1.6.9] — 2026-04-13

### Fixed
- **BREAKING** `split_position`: schema used `{tokenId, size, price}` but platform expects `{tokenId, amount}` (decimal string) — all split calls returned 400 (closes #32)
- **BREAKING** `merge_position`: schema used `{tokenIds: [...]}` (array of UUIDs) but platform expects `{tokenId, amount}` (single token + decimal string) — all merge calls returned 400 (closes #32)
- **BREAKING** `provide_liquidity`: schema used `{tokenId, spread, size}` but platform expects `{marketId, size}` — wrong identifier field and phantom `spread` field caused 400 (closes #32)
- **BREAKING** `redeem_position`: schema used `{tokenId, conditionId}` but platform expects `{positionId, marketId}` — completely wrong field names, redemption was non-functional (closes #33)
- **BREAKING** `import_strategy`: body handler unwrapped `.data` property, stripping required `polyforge` and `strategy` fields — all imports returned 422 (closes #34)
- **BREAKING** `create_alert`: three compounding bugs — field names (`type`→`direction`, `threshold`→`price`), case (`ABOVE`/`BELOW`→`above`/`below`), and Zod schema didn't match tool input schema — all alert creation returned 422 (closes #51)

## [1.6.8] — 2026-04-13

### Fixed
- **BREAKING** `ai_query`: Zod schema and tool input use `query` instead of `question` to match platform `AiQueryDto` — AI queries were returning HTTP 400 (closes #85, regression of #50)
- **BREAKING** `create_strategy_from_description`: Zod schema and tool input use `description` instead of `query` to match platform `CreateFromDescriptionDto` — AI strategy creation was returning HTTP 400 (closes #86, regression of #38)
- **BREAKING** `create_webhook`: tool description now lists SCREAMING_SNAKE_CASE event names (`ORDER_FILLED` etc.) to match platform validation (closes #87, regression of #43)
- **BREAKING** `start_strategy`: tool input enum uses lowercase `"live"`/`"paper"` instead of uppercase to match platform `StartStrategyDto` (closes #88, regression of #41)

## [Unreleased]

### Security
- **Rate limiter (concurrency)**: wrap token bucket in async promise-chain mutex to prevent concurrent MCP tool invocations from bypassing rate limits during burst traffic; also apply rate limiting to `get_strategy_events` SSE polling which previously bypassed the limiter entirely (closes #39)
- **API URL localhost fallback**: log explicit warning when `POLYFORGE_API_URL` is not set and the server falls back to `https://localhost:3002`; warns against `NODE_TLS_REJECT_UNAUTHORIZED=0` workaround; documents that production must set a real HTTPS endpoint (closes #47)

### Fixed
- **BREAKING**: `close_position` Zod schema used `outcome` (enum YES/NO) instead of `size` (number) — partial close requests silently lost the size parameter, potentially closing entire positions instead of the requested amount (closes #58)
- **BREAKING**: `create_strategy` Zod schema used `tokenId` instead of `marketId` — market binding was silently stripped; also removed phantom `rules` field not in platform contract (closes #59)
- **BREAKING**: `create_conditional_order` Zod schema missing `marketId` and `type` fields (stripped by Zod, causing 422 errors); `price` renamed to `limitPrice` to match platform DTO; `triggerPrice` made required; added all 5 conditional order types (`TAKE_PROFIT`, `STOP_LOSS`, `TRAILING_STOP`, `LIMIT`, `PEGGED`) instead of only 2; added `trailingPct` and `expiresAt` optional fields (closes #52)

### Security
- **DNS rebinding SSRF mitigation**: `validateWebhookUrl()` now resolves domain names via `dns.resolve4()`/`dns.resolve6()` and checks all resolved IPs against the private IP blocklist, preventing SSRF bypass via attacker-controlled DNS records; also handles decimal/octal-encoded IPs via URL parsing normalization; documents that this is a client-side best-effort check and the server must independently validate (closes #35)
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
