#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "polyforge", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// ─── Tool definitions ──────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_markets",
    description: "Browse prediction markets on Polymarket. Returns paginated results with market title, category, volume, and current prices.",
    inputSchema: {
      type: "object" as const,
      properties: {
        search: { type: "string", description: "Search query to filter markets by title" },
        category: { type: "string", enum: ["Sports", "Crypto", "Politics", "Science", "Culture"], description: "Filter by category" },
        limit: { type: "number", description: "Max results per page (default 10, max 100)" },
        page: { type: "number", description: "Page number (default 1)" },
      },
    },
  },
  {
    name: "get_market",
    description: "Get details of a specific prediction market including tokens, prices, and order book depth",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Market condition ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_strategies",
    description: "List your trading strategies with optional status filter",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["IDLE", "RUNNING", "PAUSED", "PAPER"], description: "Filter by strategy status" },
      },
    },
  },
  {
    name: "get_strategy",
    description: "Get full details of a specific strategy including blocks, configuration, and run history",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_strategy",
    description: "Create a new trading strategy with a name and optional description",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Strategy name" },
        description: { type: "string", description: "Strategy description" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_strategy_from_description",
    description: "Create a strategy from a natural language description. AI generates the block configuration automatically.",
    inputSchema: {
      type: "object" as const,
      properties: {
        description: { type: "string", description: "Natural language description of what the strategy should do (e.g. 'buy YES on Trump markets when price drops below 40 cents')" },
        marketId: { type: "string", description: "Optional market ID to bind the strategy to" },
      },
      required: ["description"],
    },
  },
  {
    name: "start_strategy",
    description: "Start a strategy in live or paper (simulated) trading mode",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
        mode: { type: "string", enum: ["live", "paper"], description: "Trading mode — paper is simulated, live places real orders (default: paper)" },
      },
      required: ["id"],
    },
  },
  {
    name: "stop_strategy",
    description: "Stop a running strategy. Open positions are NOT automatically closed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_strategy_templates",
    description: "List available strategy templates that can be used as starting points",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "export_strategy",
    description: "Export a strategy configuration as a portable .polyforge JSON file",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_portfolio",
    description: "Get your current portfolio positions, unrealized P&L, and account summary",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_orders",
    description: "List your recent orders with optional filters",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max results (default 20)" },
        status: { type: "string", description: "Filter by order status (e.g. FILLED, PENDING, CANCELLED)" },
      },
    },
  },
  {
    name: "get_score",
    description: "Get your trader edge score, rank, and earned badges",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_whale_feed",
    description: "Get recent large trades (whale activity) from Polymarket",
    inputSchema: {
      type: "object" as const,
      properties: {
        minSize: { type: "number", description: "Minimum trade size in USDC (default 10000)" },
      },
    },
  },
  {
    name: "get_news_signals",
    description: "Get AI-generated trading signals derived from news articles",
    inputSchema: {
      type: "object" as const,
      properties: {
        minConfidence: { type: "number", description: "Minimum confidence score 1-100 (default 70)" },
      },
    },
  },
  {
    name: "list_alerts",
    description: "List your configured price alerts",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "list_copy_configs",
    description: "List your copy trading configurations (wallets you're following)",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "list_webhooks",
    description: "List your registered webhook endpoints",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "create_webhook",
    description: "Register a webhook endpoint to receive real-time event notifications",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "HTTPS URL to receive POST event payloads" },
        events: {
          type: "array",
          items: { type: "string" },
          description: "Event types to subscribe to: ORDER_FILLED, STRATEGY_ERROR, WHALE_TRADE, NEWS_SIGNAL, BACKTEST_COMPLETE, DAILY_LOSS_LIMIT, MARKET_RESOLVED, PRICE_ALERT",
        },
      },
      required: ["url", "events"],
    },
  },
  {
    name: "ai_query",
    description: "Ask a natural language question about your account, strategies, portfolio, or market data. The AI interprets your question and returns relevant information.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Natural language query (e.g. 'what are my best performing strategies this week?')" },
      },
      required: ["query"],
    },
  },
];

// ─── Route mapping ─────────────────────────────────────────────────

interface RouteConfig {
  method: "GET" | "POST" | "DELETE";
  path: string | ((args: Record<string, unknown>) => string);
  query?: (args: Record<string, unknown>) => Record<string, string>;
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
}

const ROUTES: Record<string, RouteConfig> = {
  list_markets: { method: "GET", path: "/api/v1/markets", query: (a) => pickDefined(a, ["search", "category", "limit", "page"]) },
  get_market: { method: "GET", path: (a) => `/api/v1/markets/${a.id}` },
  list_strategies: { method: "GET", path: "/api/v1/strategies", query: (a) => pickDefined(a, ["status"]) },
  get_strategy: { method: "GET", path: (a) => `/api/v1/strategies/${a.id}` },
  create_strategy: { method: "POST", path: "/api/v1/strategies", body: (a) => a },
  create_strategy_from_description: { method: "POST", path: "/api/v1/strategies/from-description", body: (a) => a },
  start_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${a.id}/start`, body: (a) => ({ mode: a.mode ?? "paper" }) },
  stop_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${a.id}/stop` },
  get_strategy_templates: { method: "GET", path: "/api/v1/strategies/templates" },
  export_strategy: { method: "GET", path: (a) => `/api/v1/strategies/${a.id}/export` },
  get_portfolio: { method: "GET", path: "/api/v1/portfolio" },
  get_orders: { method: "GET", path: "/api/v1/orders", query: (a) => pickDefined(a, ["limit", "status"]) },
  get_score: { method: "GET", path: "/api/v1/scores/me" },
  get_whale_feed: { method: "GET", path: "/api/v1/whales/feed", query: (a) => pickDefined(a, ["minSize"]) },
  get_news_signals: { method: "GET", path: "/api/v1/news/signals", query: (a) => pickDefined(a, ["minConfidence"]) },
  list_alerts: { method: "GET", path: "/api/v1/alerts" },
  list_copy_configs: { method: "GET", path: "/api/v1/copy" },
  list_webhooks: { method: "GET", path: "/api/v1/webhooks" },
  create_webhook: { method: "POST", path: "/api/v1/webhooks", body: (a) => a },
  ai_query: { method: "POST", path: "/api/v1/ai/query", body: (a) => a },
};

function pickDefined(obj: Record<string, unknown>, keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) {
      result[k] = String(obj[k]);
    }
  }
  return result;
}

// ─── Handlers ──────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const apiUrl = process.env.POLYFORGE_API_URL || "http://localhost:3002";
  const apiKey = process.env.POLYFORGE_API_KEY;

  if (!apiKey) {
    return {
      content: [{ type: "text", text: "Error: POLYFORGE_API_KEY environment variable is not set. Generate an API key in Polyforge Settings > API Keys." }],
      isError: true,
    };
  }

  const route = ROUTES[name];
  if (!route) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const result = await callApi(apiUrl, apiKey, route, args as Record<string, unknown>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `API error: ${message}` }],
      isError: true,
    };
  }
});

// ─── API client ────────────────────────────────────────────────────

async function callApi(
  baseUrl: string,
  apiKey: string,
  route: RouteConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  const path = typeof route.path === "function" ? route.path(args) : route.path;
  const url = new URL(path, baseUrl);

  if (route.query) {
    const params = route.query(args);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method: route.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: route.body ? JSON.stringify(route.body(args)) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }

  return res.json();
}

// ─── Start ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport);
