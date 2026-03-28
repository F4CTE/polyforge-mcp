# Polyforge MCP Server

MCP (Model Context Protocol) server that lets AI assistants interact with the [Polyforge](https://github.com/your-org/polyforge) prediction market trading platform.

## Quick Start

```bash
npx @polyforge/mcp-server
```

## Setup

### 1. Get an API Key

Generate an API key in the Polyforge web app: **Settings > API Keys > Create Key**.

### 2. Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "polyforge": {
      "command": "npx",
      "args": ["@polyforge/mcp-server"],
      "env": {
        "POLYFORGE_API_URL": "https://your-polyforge-instance.com",
        "POLYFORGE_API_KEY": "pf_your_api_key_here"
      }
    }
  }
}
```

### 3. Configure Claude Code

```bash
claude mcp add polyforge -- npx @polyforge/mcp-server
```

Then set environment variables:
```bash
export POLYFORGE_API_URL=https://your-polyforge-instance.com
export POLYFORGE_API_KEY=pf_your_api_key_here
```

## Available Tools (22)

### Markets
| Tool | Description |
|------|-------------|
| `list_markets` | Browse prediction markets with search, category filter, pagination |
| `get_market` | Get market details including tokens, prices, order book |

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

### Portfolio & Orders
| Tool | Description |
|------|-------------|
| `get_portfolio` | Current positions and P&L |
| `get_orders` | Recent orders with filters |
| `get_score` | Trader edge score and badges |

### Social & Signals
| Tool | Description |
|------|-------------|
| `get_whale_feed` | Recent large trades |
| `get_news_signals` | AI trading signals from news |

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

MIT
