#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "polyforge", version: "1.3.0" },
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
  {
    name: "place_order",
    description: "Place a direct buy or sell order on a prediction market. Requires a connected Polymarket wallet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Token ID to trade (get from market details)" },
        side: { type: "string", enum: ["BUY", "SELL"], description: "Order side" },
        outcome: { type: "string", enum: ["YES", "NO"], description: "Market outcome to trade" },
        size: { type: "number", description: "Number of shares (minimum 1)" },
        price: { type: "number", description: "Limit price per share (0.001-0.999). Use 0.999 for market buy, 0.001 for market sell." },
        orderType: { type: "string", enum: ["GTC", "FOK", "GTD"], description: "Order type: GTC (good till cancel), FOK (fill or kill / market order), GTD (good till date). Default: GTC" },
      },
      required: ["tokenId", "side", "outcome", "size", "price"],
    },
  },
  {
    name: "cancel_order",
    description: "Cancel a pending or live order",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Order ID to cancel" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_portfolio_pnl",
    description: "Get P&L chart data and win-rate for a time period. Optionally filter by strategy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        period: { type: "string", enum: ["7d", "30d", "90d", "allTime"], description: "Time period (default: 30d)" },
        strategyId: { type: "string", description: "Filter P&L to a specific strategy (optional)" },
      },
    },
  },
  {
    name: "list_backtests",
    description: "List historical backtests for your strategies.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max results (default 20)" },
        page: { type: "number", description: "Page number (default 1)" },
        strategyId: { type: "string", description: "Filter by strategy ID" },
      },
    },
  },
  {
    name: "get_backtest",
    description: "Get full results and candle data for a specific backtest.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Backtest UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "run_backtest",
    description: "Start a new backtest for a strategy over a historical date range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        strategyId: { type: "string", description: "Strategy UUID to backtest" },
        startDate: { type: "string", description: "ISO 8601 start date (e.g. 2024-01-01)" },
        endDate: { type: "string", description: "ISO 8601 end date (e.g. 2024-12-31)" },
        initialCapital: { type: "number", description: "Starting USDC capital (default 1000)" },
      },
      required: ["strategyId"],
    },
  },
  {
    name: "create_alert",
    description: "Create a price alert for a market token. Triggers when the price crosses the threshold.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Token ID to monitor" },
        type: { type: "string", enum: ["ABOVE", "BELOW"], description: "Alert when price goes above or below threshold" },
        threshold: { type: "number", description: "Price threshold (0.001-0.999)" },
        message: { type: "string", description: "Optional custom message for the alert" },
      },
      required: ["tokenId", "type", "threshold"],
    },
  },
  {
    name: "delete_alert",
    description: "Delete an existing price alert.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Alert UUID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "close_position",
    description: "Close an open position by selling all shares at market price (FOK order).",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Token ID of the position to close" },
        size: { type: "string", description: "Size to close (optional, defaults to full position)" },
      },
      required: ["tokenId"],
    },
  },
  {
    name: "list_conditional_orders",
    description: "List your take-profit and stop-loss conditional orders.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", description: "Filter by status: PENDING, TRIGGERED, CANCELLED" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "create_conditional_order",
    description: "Create a take-profit or stop-loss conditional order that triggers automatically when the market price reaches your threshold.",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: { type: "string", description: "Market UUID" },
        tokenId: { type: "string", description: "Token ID to trade when triggered" },
        type: { type: "string", enum: ["TAKE_PROFIT", "STOP_LOSS"], description: "Conditional order type" },
        side: { type: "string", enum: ["BUY", "SELL"], description: "Order side when triggered" },
        outcome: { type: "string", enum: ["YES", "NO"], description: "Market outcome" },
        size: { type: "string", description: "Number of shares" },
        triggerPrice: { type: "string", description: "Price that triggers the order (0.001-0.999)" },
      },
      required: ["marketId", "tokenId", "type", "side", "outcome", "size", "triggerPrice"],
    },
  },
  {
    name: "get_arbitrage_opportunities",
    description: "Scan all active prediction markets for merge arbitrage opportunities — markets where YES + NO prices sum to less than $1.00, locking in risk-free profit on resolution.",
    inputSchema: {
      type: "object" as const,
      properties: {
        minMargin: { type: "number", description: "Minimum profit margin percentage to include (default 0.5). Example: 2 = only show opportunities with 2%+ profit." },
      },
    },
  },
  {
    name: "place_smart_order",
    description: "Place an advanced smart order: TWAP (time-weighted), DCA (dollar-cost averaging), BRACKET (entry + take-profit + stop-loss bundle), or OCO (one-cancels-other).",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string", enum: ["TWAP", "DCA", "BRACKET", "OCO"], description: "Smart order execution algorithm" },
        tokenId: { type: "string", description: "Token ID to trade" },
        side: { type: "string", enum: ["BUY", "SELL"], description: "Order side" },
        outcome: { type: "string", enum: ["YES", "NO"], description: "Market outcome" },
        totalSize: { type: "number", description: "Total USDC size to deploy" },
        slices: { type: "number", description: "Number of equal slices (TWAP/DCA, 2–100)" },
        intervalMinutes: { type: "number", description: "Minutes between slices (TWAP/DCA, 1–10080)" },
        limitPrice: { type: "number", description: "Optional limit price per slice (TWAP/DCA)" },
        entryPrice: { type: "number", description: "Entry limit price (BRACKET)" },
        takeProfitPrice: { type: "number", description: "Take-profit price (BRACKET)" },
        stopLossPrice: { type: "number", description: "Stop-loss price (BRACKET)" },
        priceA: { type: "number", description: "First leg price (OCO)" },
        priceB: { type: "number", description: "Second leg price (OCO)" },
      },
      required: ["type", "tokenId", "side", "outcome", "totalSize"],
    },
  },
  {
    name: "list_smart_orders",
    description: "List your smart orders (TWAP, DCA, BRACKET, OCO) with execution progress and child order details.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "cancel_smart_order",
    description: "Cancel a pending or active smart order and all its child orders.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Smart order UUID to cancel" },
      },
      required: ["id"],
    },
  },
  {
    name: "browse_marketplace",
    description: "Browse the Polyforge Strategy Marketplace — strategies published by other traders that you can purchase and fork to your account.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sort: { type: "string", enum: ["newest", "popular", "rating", "price_asc", "price_desc"], description: "Sort order (default: newest)" },
        tag: { type: "string", description: "Filter by tag (e.g. 'crypto', 'politics')" },
        limit: { type: "number", description: "Max results (default 20, max 100)" },
      },
    },
  },
  {
    name: "purchase_strategy",
    description: "Purchase a marketplace strategy. You receive a private fork in your account that you can customize and run. Platform takes a 20% fee.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Marketplace listing UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_accuracy",
    description: "Get prediction accuracy and calibration score for the authenticated user",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_portfolio_review",
    description: "Get AI-generated portfolio review and optimization suggestions",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "get_market_sentiment",
    description: "Get aggregated news sentiment for a specific market",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: { type: "string", description: "Market ID to get sentiment for" },
      },
      required: ["marketId"],
    },
  },
  {
    name: "provide_liquidity",
    description: "Provide liquidity by placing two-sided quotes on a market token",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Token ID to provide liquidity for" },
        spread: { type: "number", description: "Spread between bid and ask (e.g., 0.02 for 2%)" },
        size: { type: "number", description: "Size in USDC to provide on each side" },
      },
      required: ["tokenId", "spread", "size"],
    },
  },
  {
    name: "get_strategy_events",
    description:
      "Poll recent execution events for a running strategy. Returns up to `limit` events that arrived since the given `after_timestamp` (Unix ms). " +
      "Call repeatedly to simulate a live feed — increment `after_timestamp` to the latest event's timestamp between calls. " +
      "Note: MCP tools are request-response only; for continuous streaming use the TypeScript, Python, or Rust SDK instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID to watch" },
        after_timestamp: {
          type: "number",
          description:
            "Only return events with timestamp > this value (Unix ms). Pass 0 for all recent events. Default: 0",
        },
        limit: {
          type: "number",
          description: "Max events to return (default 20, max 100)",
        },
      },
      required: ["id"],
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
  get_accuracy: { method: "GET", path: "/api/v1/accuracy/me" },
  get_portfolio_review: { method: "GET", path: "/api/v1/ai/portfolio-review" },
  get_market_sentiment: { method: "GET", path: (a) => `/api/v1/news/sentiment/${a.marketId}` },
  provide_liquidity: { method: "POST", path: "/api/v1/lp/provide", body: (a) => ({ tokenId: a.tokenId, spread: a.spread, size: a.size }) },
  list_alerts: { method: "GET", path: "/api/v1/alerts" },
  list_copy_configs: { method: "GET", path: "/api/v1/copy" },
  list_webhooks: { method: "GET", path: "/api/v1/webhooks" },
  create_webhook: { method: "POST", path: "/api/v1/webhooks", body: (a) => a },
  ai_query: { method: "POST", path: "/api/v1/ai/query", body: (a) => a },
  place_order: { method: "POST", path: "/api/v1/orders/place", body: (a) => a },
  cancel_order: { method: "DELETE", path: (a) => `/api/v1/orders/${a.id}` },
  get_portfolio_pnl: { method: "GET", path: "/api/v1/portfolio/pnl", query: (a) => pickDefined(a, ["period", "strategyId"]) },
  list_backtests: { method: "GET", path: "/api/v1/backtests", query: (a) => pickDefined(a, ["limit", "page", "strategyId"]) },
  get_backtest: { method: "GET", path: (a) => `/api/v1/backtests/${a.id}` },
  run_backtest: { method: "POST", path: "/api/v1/backtests", body: (a) => a },
  create_alert: { method: "POST", path: "/api/v1/alerts", body: (a) => a },
  delete_alert: { method: "DELETE", path: (a) => `/api/v1/alerts/${a.id}` },
  close_position: { method: "POST", path: "/api/v1/orders/close-position", body: (a) => a },
  list_conditional_orders: { method: "GET", path: "/api/v1/orders/conditional", query: (a) => pickDefined(a, ["status", "limit"]) },
  create_conditional_order: { method: "POST", path: "/api/v1/orders/conditional", body: (a) => a },
  get_arbitrage_opportunities: { method: "GET", path: "/api/v1/arbitrage", query: (a) => pickDefined(a, ["minMargin"]) },
  place_smart_order: { method: "POST", path: "/api/v1/orders/smart", body: (a) => a },
  list_smart_orders: { method: "GET", path: "/api/v1/orders/smart" },
  cancel_smart_order: { method: "DELETE", path: (a) => `/api/v1/orders/smart/${a.id}` },
  browse_marketplace: { method: "GET", path: "/api/v1/marketplace", query: (a) => pickDefined(a, ["sort", "tag", "limit"]) },
  purchase_strategy: { method: "POST", path: (a) => `/api/v1/marketplace/${a.id}/purchase` },
  // get_strategy_events is handled separately (SSE polling, not a simple REST call)
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

  // ── get_strategy_events: SSE polling (collect N events then return) ──────
  if (name === "get_strategy_events") {
    const { id, after_timestamp = 0, limit = 20 } = args as {
      id: string;
      after_timestamp?: number;
      limit?: number;
    };
    const cap = Math.min(Number(limit), 100);
    try {
      const result = await pollStrategyEvents(apiUrl, apiKey, String(id), Number(after_timestamp), cap);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `API error: ${message}` }], isError: true };
    }
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

// ─── Strategy events SSE poller ────────────────────────────────────

/**
 * Opens the SSE stream for a strategy, collects up to `limit` events that
 * arrived after `afterTimestamp`, then closes the connection and returns them.
 *
 * This lets MCP tools (which are request-response) surface execution events
 * without keeping a persistent connection open.
 */
async function pollStrategyEvents(
  baseUrl: string,
  apiKey: string,
  strategyId: string,
  afterTimestamp: number,
  limit: number,
): Promise<{ events: unknown[]; nextAfterTimestamp: number }> {
  const url = new URL(`/api/v1/strategies/${encodeURIComponent(strategyId)}/events`, baseUrl);
  const controller = new AbortController();

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
    signal: controller.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }

  const events: unknown[] = [];
  let nextTs = afterTimestamp;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (events.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          const payload = JSON.parse(raw) as { type?: string; timestamp?: number };
          // Filter events newer than the requested cursor
          if ((payload.timestamp ?? 0) > afterTimestamp) {
            events.push(payload);
            if ((payload.timestamp ?? 0) > nextTs) nextTs = payload.timestamp ?? nextTs;
            if (events.length >= limit) break;
          }
        } catch {
          // skip malformed
        }
      }
    }
  } finally {
    controller.abort();
    reader.cancel().catch(() => undefined);
  }

  return { events, nextAfterTimestamp: nextTs };
}

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
