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

## Available Tools (33)

### Markets
| Tool | Description |
|------|-------------|
| `list_markets` | Browse prediction markets with search, category filter, pagination |
| `get_market` | Get market details including tokens, prices, order book |
| `provide_liquidity` | Place two-sided liquidity quotes on a market token |

### Strategies
| Tool | Description |
|------|-------------|
| `list_strategies` | List your strategies with status filter |
| `get_strategy` | Get full strategy details and run history |
| `create_strategy` | Create a new strategy |
| `create_strategy_from_description` | AI-generate a strategy from natural language |
| `start_strategy` | Start in live or paper mode |
| `stop_strategy` | Stop a running strategy |
| `get_strategy_templates` | List available templates |
| `export_strategy` | Export as .polyforge JSON |
| `get_strategy_events` | Poll recent execution events for a running strategy |

### Portfolio & Orders
| Tool | Description |
|------|-------------|
| `get_portfolio` | Current positions and P&L |
| `get_orders` | Recent orders with filters |
| `get_score` | Trader edge score and badges |
| `place_order` | Place a direct buy/sell order on a market |
| `cancel_order` | Cancel a pending or live order |
| `get_accuracy` | Get prediction accuracy stats (Brier score, calibration, win rate) |
| `get_portfolio_review` | Get AI-generated portfolio review and optimization suggestions |

### Social & Signals
| Tool | Description |
|------|-------------|
| `get_whale_feed` | Recent large trades |
| `get_news_signals` | AI trading signals from news |
| `get_market_sentiment` | Get aggregated news sentiment for a market (BULLISH/BEARISH/NEUTRAL) |

### Configuration
| Tool | Description |
|------|-------------|
| `list_alerts` | Price alerts |
| `list_copy_configs` | Copy trading configurations |
| `list_webhooks` | Registered webhooks |
| `create_webhook` | Register event webhook |

### AI
| Tool | Description |
|------|-------------|
| `ai_query` | Natural language questions about your account |

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

## Development

```bash
git clone https://github.com/your-org/polyforge-mcp.git
cd polyforge-mcp
npm install
npm run build
```

Test locally:
```bash
POLYFORGE_API_KEY=pf_test_key node dist/index.js
```

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
