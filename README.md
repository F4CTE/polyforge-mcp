# Polyforge MCP Server

MCP (Model Context Protocol) server that lets AI assistants interact with the [Polyforge](https://polyforge.app) prediction market trading platform.

Implements the open **MCP 1.0 stdio standard** — compatible with Claude Desktop, Claude Code, Cursor, Windsurf, Zed, Continue, and any MCP-compliant host.

## Quick Start

```bash
npx @polyforge/mcp-server
```

## Setup

### 1. Get an API Key

Generate an API key in the Polyforge web app: **Settings > API Keys > Create Key**.

---

### Claude Desktop

Add to `claude_desktop_config.json`:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "polyforge": {
      "command": "npx",
      "args": ["@polyforge/mcp-server"],
      "env": {
        "POLYFORGE_API_KEY": "pf_live_your_key"
      }
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add polyforge -- npx @polyforge/mcp-server
export POLYFORGE_API_KEY=pf_live_your_key
```

### Cursor

Open **Cursor Settings → MCP → Add Server**, or add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "polyforge": {
      "command": "npx",
      "args": ["@polyforge/mcp-server"],
      "env": {
        "POLYFORGE_API_KEY": "pf_live_your_key"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "polyforge": {
      "command": "npx",
      "args": ["@polyforge/mcp-server"],
      "env": {
        "POLYFORGE_API_KEY": "pf_live_your_key"
      }
    }
  }
}
```

### Zed

Add to `settings.json` under `context_servers`:

```json
{
  "context_servers": {
    "polyforge": {
      "command": {
        "path": "npx",
        "args": ["@polyforge/mcp-server"],
        "env": {
          "POLYFORGE_API_KEY": "pf_live_your_key"
        }
      }
    }
  }
}
```

### Continue.dev

Add to `~/.continue/config.json` under `mcpServers`:

```json
{
  "mcpServers": [
    {
      "name": "polyforge",
      "command": "npx",
      "args": ["@polyforge/mcp-server"],
      "env": {
        "POLYFORGE_API_KEY": "pf_live_your_key"
      }
    }
  ]
}
```

### Custom / Any MCP Client

Install globally and spawn:

```bash
npm install -g @polyforge/mcp-server
POLYFORGE_API_KEY=pf_live_your_key polyforge-mcp
```

## Available Tools (123)

### Markets & Price Data (9)
| Tool | Description |
|------|-------------|
| `list_markets` | Browse prediction markets with search, category filter, pagination |
| `get_market` | Get market details including tokens, prices, order book depth |
| `search_markets` | Search prediction markets by keyword |
| `get_price_history` | Historical price candles (1m/1h/1d) with optional date range |
| `get_tick_size` | Minimum tick size (price increment) for a token on the CLOB |
| `get_spread` | Current bid-ask spread for a market token |
| `get_midpoint` | Current midpoint price for a market token |
| `get_clob_book` | Full CLOB order book (bids and asks) for a token |
| `get_clob_prices_history` | Historical CLOB prices with configurable interval and fidelity |

### Strategies (16)
| Tool | Description |
|------|-------------|
| `list_strategies` | List your strategies with status filter, sorting, pagination |
| `get_strategy` | Get full strategy details including blocks, configuration, run history |
| `create_strategy` | Create a new strategy with blocks, execution mode, visibility, tags |
| `update_strategy` | Update a strategy's blocks, execution mode, visibility, tags |
| `create_strategy_from_description` | AI-generate a strategy from natural language |
| `start_strategy` | Start in live or paper (simulated) mode |
| `stop_strategy` | Stop a running strategy |
| `pause_strategy` | Pause a running strategy (keeps state, can resume) |
| `resume_strategy` | Resume a previously paused strategy |
| `fork_strategy` | Fork a strategy to create a new editable copy |
| `delete_strategy` | Permanently delete a stopped strategy |
| `import_strategy` | Import a strategy from a .polyforge JSON export |
| `export_strategy` | Export strategy as a portable .polyforge JSON file |
| `get_strategy_templates` | List available strategy templates |
| `list_strategy_versions` | List saved version history of a strategy |
| `rollback_strategy` | Roll back a strategy to a previous version |

### Strategy Monitoring (2)
| Tool | Description |
|------|-------------|
| `get_strategy_events` | Poll recent execution events (cursor-based live feed) |
| `get_strategy_event_log` | Persistent audit log (execution history, parameter changes, starts/stops) |

### Strategy Social (6)
| Tool | Description |
|------|-------------|
| `like_strategy` | Like a public strategy |
| `list_strategy_comments` | List comments on a public strategy |
| `add_strategy_comment` | Post a comment on a public strategy |
| `delete_strategy_comment` | Delete one of your own comments |
| `list_strategy_children` | List strategies forked from a given strategy |
| `report_strategy` | Report a strategy for violating community guidelines |

### Discovery & Leaderboard (2)
| Tool | Description |
|------|-------------|
| `discover_strategies` | Browse public community strategies with sort and search |
| `get_leaderboard` | Top trader leaderboard ranked by P&L (7d/30d/allTime) |

### Marketplace (8)
| Tool | Description |
|------|-------------|
| `browse_marketplace` | Browse the Strategy Marketplace (sort, tag filter, pagination) |
| `get_marketplace_listing` | Full listing details including reviews and performance stats |
| `purchase_strategy` | Purchase a marketplace strategy (creates a private fork) |
| `create_marketplace_listing` | Publish your strategy to the marketplace |
| `update_marketplace_listing` | Update title, price, description, or tags of your listing |
| `rate_marketplace_listing` | Rate and review a purchased strategy (1–5 stars) |
| `get_my_listings` | List your published marketplace strategies with sales count |
| `get_my_purchases` | List marketplace strategies you have purchased |

### Orders & Execution (13)
| Tool | Description |
|------|-------------|
| `place_order` | Place a buy/sell order (GTC/FOK/GTD/FAK/POST_ONLY) |
| `cancel_order` | Cancel a pending or live order |
| `get_orders` | List recent orders with status, strategy, market, date filters |
| `place_smart_order` | Advanced execution: TWAP, DCA, BRACKET, or OCO |
| `list_smart_orders` | List smart orders with execution progress |
| `cancel_smart_order` | Cancel a smart order and all child orders |
| `place_batch_orders` | Place 1–15 orders in a single batch |
| `cancel_orders_bulk` | Cancel 1–3000 orders in bulk |
| `list_conditional_orders` | List take-profit, stop-loss, trailing stop orders |
| `create_conditional_order` | Create a conditional order (TP/SL/trailing/limit/pegged) |
| `get_conditional_order` | Get details of a specific conditional order |
| `cancel_conditional_order` | Cancel a pending conditional order |
| `get_arbitrage_opportunities` | Scan markets for merge arbitrage (YES+NO < $1.00) |

### Portfolio & Positions (10)
| Tool | Description |
|------|-------------|
| `get_portfolio` | Current positions, unrealized P&L, account summary |
| `get_portfolio_pnl` | P&L chart data and win-rate for a time period |
| `get_portfolio_review` | AI-generated portfolio review and optimization suggestions |
| `close_position` | Close an open position at market price |
| `split_position` | Split USDC.e collateral into YES and NO tokens |
| `merge_position` | Merge YES and NO tokens back into USDC.e |
| `redeem_position` | Redeem winning shares after market resolution |
| `get_polymarket_portfolio` | Polymarket-native portfolio (positions, balances, exposure) |
| `get_polymarket_earnings` | Polymarket-native earnings (realized PnL, redeemed winnings) |
| `get_polymarket_activity` | Polymarket-native activity feed (trades, redemptions) |

### Copy Trading (8)
| Tool | Description |
|------|-------------|
| `list_copy_configs` | List your copy trading configurations |
| `create_copy_config` | Create a new config to mirror trades from a target wallet |
| `get_copy_config` | Get details of a specific copy config |
| `update_copy_config` | Update sizing mode, risk limits, or price offset |
| `pause_copy_config` | Pause — no new trades copied until resumed |
| `resume_copy_config` | Resume a paused copy config |
| `delete_copy_config` | Permanently delete a copy config |
| `get_copy_trades` | List all trades executed under a copy config |

### Whale Intelligence (6)
| Tool | Description |
|------|-------------|
| `get_whale_feed` | Recent large trades (whale activity) |
| `get_top_whales` | Top whales ranked by volume, P&L, win rate, or trade count |
| `get_whale_profile` | Full trading profile for a specific whale wallet |
| `follow_whale` | Follow a whale to receive their trades in your feed |
| `unfollow_whale` | Unfollow a whale wallet |
| `get_followed_whales` | List all whale wallets you are following |

### News & Signals (4)
| Tool | Description |
|------|-------------|
| `get_news_signals` | AI-generated trading signals derived from news |
| `get_market_sentiment` | Aggregated news sentiment (BULLISH/BEARISH/NEUTRAL) |
| `list_news` | List recent news articles relevant to prediction markets |
| `get_news_article` | Get full content of a specific news article |

### Scoring & Badges (6)
| Tool | Description |
|------|-------------|
| `get_score` | Your trader edge score, rank, and badges |
| `get_accuracy` | Prediction accuracy (Brier score, calibration, win rate) |
| `get_top_scores` | Top user scores leaderboard |
| `get_my_badges` | Badges earned by you |
| `get_user_score` | Score and trading stats for a specific user |
| `get_user_badges` | Badges earned by a specific user |

### Backtesting (4)
| Tool | Description |
|------|-------------|
| `list_backtests` | List historical backtests with status filter |
| `get_backtest` | Full results and candle data for a specific backtest |
| `run_backtest` | Start a new backtest over a historical date range |
| `get_backtest_orders` | Simulated order log from a completed backtest |

### Alerts (3)
| Tool | Description |
|------|-------------|
| `list_alerts` | List your configured price alerts |
| `create_alert` | Create a price alert (triggers when price crosses threshold) |
| `delete_alert` | Delete an existing price alert |

### Watchlist (4)
| Tool | Description |
|------|-------------|
| `list_watchlist` | List watched markets with prices, volume, and price delta |
| `add_to_watchlist` | Add a market to your watchlist |
| `remove_from_watchlist` | Remove a market from your watchlist |
| `get_watchlist_status` | Check if a specific market is on your watchlist |

### Webhooks (4)
| Tool | Description |
|------|-------------|
| `list_webhooks` | List your registered webhook endpoints |
| `create_webhook` | Register a webhook for real-time event notifications |
| `delete_webhook` | Delete a registered webhook |
| `test_webhook` | Send a test event payload to verify delivery |

### Rewards & Rebates (7)
| Tool | Description |
|------|-------------|
| `list_rewards_markets` | List markets eligible for liquidity rewards |
| `get_rewards_for_market` | Reward details for a specific market |
| `get_user_rewards` | Your accrued liquidity rewards |
| `get_user_rewards_total` | Total accumulated rewards with date breakdown |
| `get_user_rewards_percentages` | Reward allocation percentages across markets |
| `get_user_rewards_per_market` | Rewards broken down by individual market |
| `get_user_rebates` | Your trading rebates |

### Paper Trading (2)
| Tool | Description |
|------|-------------|
| `get_paper_summary` | Paper trading account summary (virtual balance, P&L, positions) |
| `reset_paper_account` | Reset paper account to initial virtual balance |

### Risk Management (3)
| Tool | Description |
|------|-------------|
| `get_risk_settings` | Current drawdown circuit-breaker settings |
| `update_risk_settings` | Update drawdown threshold, lookback window, enable/disable |
| `reset_circuit_breaker` | Reset tripped circuit breaker to allow new orders |

### API Keys (3)
| Tool | Description |
|------|-------------|
| `list_api_keys` | List all API keys associated with your account |
| `create_api_key` | Create a new API key with scoped permissions |
| `revoke_api_key` | Permanently revoke an API key |

### Liquidity (1)
| Tool | Description |
|------|-------------|
| `provide_liquidity` | Provide liquidity by depositing USDC.e on a market token |

### AI (1)
| Tool | Description |
|------|-------------|
| `ai_query` | Natural language questions about your account, strategies, or markets |

### Batch (1)
| Tool | Description |
|------|-------------|
| `batch_requests` | Execute multiple API requests in a single call (max 10) |

### Strategy Execution Watching

`get_strategy_events` lets Claude poll execution events from a running strategy. MCP tools are request-response only, so this uses a cursor-based approach:

```
# First call — get the latest events
get_strategy_events(id="strat-uuid", after_timestamp=0, limit=20)
→ { events: [...], nextAfterTimestamp: 1711720500000 }

# Follow-up call — only events newer than the cursor
get_strategy_events(id="strat-uuid", after_timestamp=1711720500000, limit=20)
→ { events: [...], nextAfterTimestamp: 1711720510000 }
```

For continuous streaming, use the TypeScript, Python, or Rust SDK's `watchStrategy`/`watch_strategy` method instead.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POLYFORGE_API_URL` | No | `http://localhost:3002` | Polyforge API base URL |
| `POLYFORGE_API_KEY` | Yes | — | API key from Settings > API Keys |

## Example Usage

Once configured, you can ask Claude:

- "Show me the top prediction markets about crypto"
- "Create a strategy that buys YES on markets where the price drops below 30 cents"
- "What's my portfolio P&L this week?"
- "Start my momentum strategy in paper mode"
- "Show me whale trades over $50,000"
- "What events have fired on my running strategy in the last minute?"
- "Buy 10 YES shares on this market at 0.65"
- "Set up a DCA smart order to buy $500 over 5 slices every hour"
- "Show me arbitrage opportunities with at least 2% margin"
- "Copy trades from this whale wallet with a $100 fixed amount per trade"
- "Run a backtest on my momentum strategy from Jan to March"
- "What are my liquidity rewards this month?"
- "Show the full order book for this token"

## Development

```bash
git clone https://github.com/F4CTE/polyforge-mcp.git
cd polyforge-mcp
pnpm install
pnpm build
```

Test locally:
```bash
POLYFORGE_API_KEY=pf_test_key pnpm start
```

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
