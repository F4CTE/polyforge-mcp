#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";

// ─── Input validation schemas (Zod) ──────────────────────────────
// Validates all tool inputs before forwarding to the backend API.

const createStrategySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  marketId: z.string().optional(),
});

const createStrategyFromDescriptionSchema = z.object({
  description: z.string().min(1).max(5000),
});

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1).max(8),
});

const aiQuerySchema = z.object({
  query: z.string().min(1).max(5000),
  context: z.string().max(5000).optional(),
});

const placeOrderSchema = z.object({
  tokenId: z.string().uuid(),
  side: z.enum(["BUY", "SELL"]),
  outcome: z.enum(["YES", "NO"]),
  size: z.number().positive().int().min(1),
  price: z.number().min(0.001).max(0.999),
  orderType: z.enum(["GTC", "GTD", "FOK"]).optional(),
});

const runBacktestSchema = z.object({
  strategyId: z.string().uuid(),
  dateRangeStart: z.string().optional(),
  dateRangeEnd: z.string().optional(),
  initialBalance: z.number().positive().optional(),
});

const createAlertSchema = z.object({
  tokenId: z.string().uuid().optional(),
  marketId: z.string().optional(),
  condition: z.string().min(1).optional(),
  threshold: z.number().optional(),
});

const updateStrategySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  marketId: z.string().optional(),
});

const closePositionSchema = z.object({
  tokenId: z.string().uuid(),
  size: z.number().positive().optional(),
});

const redeemPositionSchema = z.object({
  tokenId: z.string().uuid(),
  conditionId: z.string().uuid().optional(),
});

const splitPositionSchema = z.object({
  tokenId: z.string().uuid(),
  size: z.number().positive().int().min(1),
  price: z.number().min(0.001).max(0.999),
});

const mergePositionSchema = z.object({
  tokenIds: z.array(z.string().uuid()).min(2),
});

const provideLiquiditySchema = z.object({
  tokenId: z.string().uuid(),
  spread: z.number().positive().max(1),
  size: z.number().positive(),
});

const startStrategySchema = z.object({
  id: z.string().uuid(),
  mode: z.enum(["live", "paper"]).default("paper"),
});

const importBlockSchema = z.object({
  type: z.string().max(100),
  config: z.record(z.string(), z.unknown()).optional(),
});

const importStrategySchema = z.object({
  data: z.object({
    polyforge: z.string().max(20),
    exportedAt: z.string().max(50).optional(),
    strategy: z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      execMode: z.enum(["TICK", "EVENT", "HYBRID"]).optional(),
      tickMs: z.number().int().min(200).max(60000).optional(),
      visibility: z.enum(["PRIVATE", "PUBLIC", "UNLISTED"]).optional(),
      tags: z.array(z.string().max(50)).max(20).optional(),
      variables: z.array(z.object({
        name: z.string().max(50).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
        expression: z.string().max(200),
      })).max(20).optional(),
      blocks: z.object({
        safety: z.array(importBlockSchema).max(20).optional(),
        triggers: z.array(importBlockSchema).max(50).optional(),
        conditions: z.array(importBlockSchema).max(50).optional(),
        actions: z.array(importBlockSchema).max(50).optional(),
      }).optional(),
      canvas: z.object({
        positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
        connections: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      }).optional(),
    }),
  }),
});

const createConditionalOrderSchema = z.object({
  marketId: z.string(),
  tokenId: z.string().uuid(),
  type: z.enum(["TAKE_PROFIT", "STOP_LOSS", "TRAILING_STOP", "LIMIT", "PEGGED"]),
  side: z.enum(["BUY", "SELL"]),
  outcome: z.enum(["YES", "NO"]),
  size: z.number().positive().int().min(1),
  triggerPrice: z.number().min(0).max(1),
  limitPrice: z.number().min(0.001).max(0.999).optional(),
  trailingPct: z.string().optional(),
  expiresAt: z.string().optional(),
});

const placeSmartOrderSchema = z.object({
  type: z.enum(["TWAP", "DCA", "BRACKET", "OCO"]),
  tokenId: z.string().uuid(),
  side: z.enum(["BUY", "SELL"]),
  outcome: z.enum(["YES", "NO"]),
  totalSize: z.number().positive().int().min(1),
  slices: z.number().int().min(2).max(100).optional(),
  intervalMinutes: z.number().int().min(1).max(10080).optional(),
  limitPrice: z.number().min(0.001).max(0.999).optional(),
  entryPrice: z.number().min(0.001).max(0.999).optional(),
  takeProfitPrice: z.number().min(0.001).max(0.999).optional(),
  stopLossPrice: z.number().min(0.001).max(0.999).optional(),
  priceA: z.number().min(0.001).max(0.999).optional(),
  priceB: z.number().min(0.001).max(0.999).optional(),
});

const getStrategyEventsSchema = z.object({
  id: z.string().uuid(),
  after_timestamp: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

// ─── ID validation schemas (#48) ────────────────────────────────
// Shared schemas for tools that accept ID parameters — enforces UUID
// format at the MCP boundary instead of forwarding arbitrary strings.

const idSchema = z.object({ id: z.string().uuid() });

const marketIdParamSchema = z.object({ marketId: z.string().uuid() });

// ─── Query parameter validation schemas (#49) ───────────────────
// Bounded limits, typed numerics, and constrained enums for all GET tools.

const listMarketsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: z.enum(["Sports", "Crypto", "Politics", "Science", "Culture"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const listStrategiesQuerySchema = z.object({
  status: z.enum(["IDLE", "RUNNING", "PAUSED", "PAPER"]).optional(),
});

const getOrdersQuerySchema = z.object({
  status: z.string().max(50).optional(),
  strategyId: z.string().uuid().optional(),
  from: z.string().max(50).optional(),
  to: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const whaleFeedQuerySchema = z.object({
  minSize: z.coerce.number().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const newsSignalsQuerySchema = z.object({
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const portfolioPnlQuerySchema = z.object({
  period: z.enum(["1d", "7d", "30d", "90d", "all"]).optional(),
  strategyId: z.string().uuid().optional(),
});

const listBacktestsQuerySchema = z.object({
  strategyId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const listConditionalOrdersQuerySchema = z.object({
  status: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const arbitrageQuerySchema = z.object({
  minMargin: z.coerce.number().min(0).max(1).optional(),
});

const browseMarketplaceQuerySchema = z.object({
  sort: z.string().max(50).optional(),
  tag: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

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
        marketId: { type: "string", description: "Optional market ID to pin this strategy to a specific market" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_strategy",
    description: "Update a strategy's name, description, or pinned market",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
        name: { type: "string", description: "New strategy name" },
        description: { type: "string", description: "New strategy description" },
        marketId: { type: "string", description: "Market ID to pin strategy to (pass empty string to unpin)" },
      },
      required: ["id"],
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
        strategyId: { type: "string", description: "Filter orders by strategy UUID" },
        from: { type: "string", description: "ISO 8601 start date filter (e.g. 2024-01-01)" },
        to: { type: "string", description: "ISO 8601 end date filter (e.g. 2024-12-31)" },
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
        query: { type: "string", description: "Natural language question (e.g. 'what are my best performing strategies this week?')" },
        context: { type: "string", description: "Optional additional context to include with the query" },
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
        dateRangeStart: { type: "string", description: "ISO 8601 start date (e.g. 2024-01-01)" },
        dateRangeEnd: { type: "string", description: "ISO 8601 end date (e.g. 2024-12-31)" },
        initialBalance: { type: "number", description: "Starting USDC balance (default 1000)" },
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
    description: "Create a conditional order that triggers automatically when the market price reaches your threshold.",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: { type: "string", description: "Market UUID" },
        tokenId: { type: "string", description: "Token ID to trade when triggered" },
        type: { type: "string", enum: ["TAKE_PROFIT", "STOP_LOSS", "TRAILING_STOP", "LIMIT", "PEGGED"], description: "Conditional order type" },
        side: { type: "string", enum: ["BUY", "SELL"], description: "Order side when triggered" },
        outcome: { type: "string", enum: ["YES", "NO"], description: "Market outcome" },
        size: { type: "number", description: "Number of shares" },
        triggerPrice: { type: "number", description: "Price that triggers the order (0-1)" },
        limitPrice: { type: "number", description: "Limit price for the order (0.001-0.999, optional)" },
        trailingPct: { type: "string", description: "Trailing percentage for TRAILING_STOP orders" },
        expiresAt: { type: "string", description: "Expiry timestamp (ISO 8601)" },
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
        offset: { type: "number", description: "Number of results to skip for pagination (default 0)" },
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
  // ── Strategy management (closes #14) ────────────────────────────────
  {
    name: "pause_strategy",
    description: "Pause a running strategy. The strategy keeps its state and can be resumed later.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "resume_strategy",
    description: "Resume a previously paused strategy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "fork_strategy",
    description: "Fork a strategy to create a new editable copy in your account.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID to fork" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_strategy",
    description: "Permanently delete a strategy. This cannot be undone. The strategy must be stopped first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "import_strategy",
    description: "Import a strategy from a .polyforge JSON export file. Creates a new strategy in your account. The 'data' field must be the full .polyforge export object with polyforge version, optional exportedAt, and a strategy object.",
    inputSchema: {
      type: "object" as const,
      properties: {
        data: {
          type: "object",
          description: "The .polyforge export object containing polyforge (version string), optional exportedAt, and strategy (with name, description, execMode, blocks, variables, canvas, etc.)",
          properties: {
            polyforge: { type: "string", description: "Export format version" },
            exportedAt: { type: "string", description: "ISO timestamp of export" },
            strategy: {
              type: "object",
              description: "Strategy definition with name, description, execMode, tickMs, visibility, tags, variables, blocks, and canvas",
            },
          },
          required: ["polyforge", "strategy"],
        },
      },
      required: ["data"],
    },
  },
  // ── Trading tools (closes #15) ──────────────────────────────────────
  {
    name: "redeem_position",
    description: "Redeem winning shares after a market resolves. Converts resolved YES/NO shares back to USDC.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Token ID of the resolved position to redeem" },
        conditionId: { type: "string", description: "Condition ID of the market (optional)" },
      },
      required: ["tokenId"],
    },
  },
  {
    name: "split_position",
    description: "Split a position into smaller positions at a specified price point.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Token ID of the position to split" },
        size: { type: "number", description: "Number of shares to split" },
        price: { type: "number", description: "Price point for the split (0.001-0.999)" },
      },
      required: ["tokenId", "size", "price"],
    },
  },
  {
    name: "merge_position",
    description: "Merge multiple positions into a single position. All tokens must be for the same market.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of token IDs to merge (minimum 2)",
        },
      },
      required: ["tokenIds"],
    },
  },
  {
    name: "get_marketplace_listing",
    description: "Get full details of a specific marketplace listing including strategy description, author, price, reviews, and performance stats.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Marketplace listing UUID" },
      },
      required: ["id"],
    },
  },
];

// ─── Route mapping ─────────────────────────────────────────────────

interface RouteConfig {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string | ((args: Record<string, unknown>) => string);
  schema?: z.ZodType<unknown>;
  query?: (args: Record<string, unknown>) => Record<string, string>;
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
}

const ROUTES: Record<string, RouteConfig> = {
  list_markets: { method: "GET", path: "/api/v1/markets", schema: listMarketsQuerySchema, query: (a) => pickDefined(a, ["search", "category", "limit", "page"]) },
  get_market: { method: "GET", path: (a) => `/api/v1/markets/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  list_strategies: { method: "GET", path: "/api/v1/strategies", schema: listStrategiesQuerySchema, query: (a) => pickDefined(a, ["status"]) },
  get_strategy: { method: "GET", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  create_strategy: { method: "POST", path: "/api/v1/strategies", body: (a) => createStrategySchema.parse(a) },
  update_strategy: { method: "PATCH", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}`, body: (a) => { const parsed = updateStrategySchema.parse(a); return pickDefined(parsed as Record<string, unknown>, ["name", "description", "marketId"]); } },
  create_strategy_from_description: { method: "POST", path: "/api/v1/strategies/from-description", body: (a) => createStrategyFromDescriptionSchema.parse(a) },
  start_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/start`, schema: startStrategySchema, body: (a) => { const parsed = startStrategySchema.parse(a); return { mode: parsed.mode }; } },
  stop_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/stop`, schema: idSchema },
  get_strategy_templates: { method: "GET", path: "/api/v1/strategies/templates" },
  export_strategy: { method: "GET", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/export`, schema: idSchema },
  get_portfolio: { method: "GET", path: "/api/v1/portfolio" },
  get_orders: { method: "GET", path: "/api/v1/orders", schema: getOrdersQuerySchema, query: (a) => pickDefined(a, ["limit", "status", "strategyId", "from", "to"]) },
  get_score: { method: "GET", path: "/api/v1/scores/me" },
  get_whale_feed: { method: "GET", path: "/api/v1/whales/feed", schema: whaleFeedQuerySchema, query: (a) => pickDefined(a, ["minSize", "limit"]) },
  get_news_signals: { method: "GET", path: "/api/v1/news/signals", schema: newsSignalsQuerySchema, query: (a) => pickDefined(a, ["minConfidence", "limit"]) },
  get_accuracy: { method: "GET", path: "/api/v1/accuracy/me" },
  get_portfolio_review: { method: "GET", path: "/api/v1/ai/portfolio-review" },
  get_market_sentiment: { method: "GET", path: (a) => `/api/v1/news/sentiment/${encodeURIComponent(String(a.marketId))}`, schema: marketIdParamSchema },
  provide_liquidity: { method: "POST", path: "/api/v1/lp/provide", body: (a) => provideLiquiditySchema.parse(a) },
  list_alerts: { method: "GET", path: "/api/v1/alerts" },
  list_copy_configs: { method: "GET", path: "/api/v1/copy" },
  list_webhooks: { method: "GET", path: "/api/v1/webhooks" },
  create_webhook: { method: "POST", path: "/api/v1/webhooks", body: (a) => createWebhookSchema.parse(a) },
  ai_query: { method: "POST", path: "/api/v1/ai/query", body: (a) => aiQuerySchema.parse(a) },
  place_order: { method: "POST", path: "/api/v1/orders/place", body: (a) => placeOrderSchema.parse(a) },
  cancel_order: { method: "DELETE", path: (a) => `/api/v1/orders/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  get_portfolio_pnl: { method: "GET", path: "/api/v1/portfolio/pnl", schema: portfolioPnlQuerySchema, query: (a) => pickDefined(a, ["period", "strategyId"]) },
  list_backtests: { method: "GET", path: "/api/v1/backtests", schema: listBacktestsQuerySchema, query: (a) => pickDefined(a, ["limit", "page", "strategyId"]) },
  get_backtest: { method: "GET", path: (a) => `/api/v1/backtests/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  run_backtest: { method: "POST", path: "/api/v1/backtests", body: (a) => runBacktestSchema.parse(a) },
  create_alert: { method: "POST", path: "/api/v1/alerts", body: (a) => createAlertSchema.parse(a) },
  delete_alert: { method: "DELETE", path: (a) => `/api/v1/alerts/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  close_position: { method: "POST", path: "/api/v1/orders/close-position", body: (a) => closePositionSchema.parse(a) },
  list_conditional_orders: { method: "GET", path: "/api/v1/orders/conditional", schema: listConditionalOrdersQuerySchema, query: (a) => pickDefined(a, ["status", "limit"]) },
  create_conditional_order: { method: "POST", path: "/api/v1/orders/conditional", body: (a) => createConditionalOrderSchema.parse(a) },
  get_arbitrage_opportunities: { method: "GET", path: "/api/v1/arbitrage", schema: arbitrageQuerySchema, query: (a) => pickDefined(a, ["minMargin"]) },
  place_smart_order: { method: "POST", path: "/api/v1/orders/smart", body: (a) => placeSmartOrderSchema.parse(a) },
  list_smart_orders: { method: "GET", path: "/api/v1/orders/smart" },
  cancel_smart_order: { method: "DELETE", path: (a) => `/api/v1/orders/smart/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  browse_marketplace: { method: "GET", path: "/api/v1/marketplace", schema: browseMarketplaceQuerySchema, query: (a) => pickDefined(a, ["sort", "tag", "limit", "offset"]) },
  purchase_strategy: { method: "POST", path: (a) => `/api/v1/marketplace/${encodeURIComponent(String(a.id))}/purchase`, schema: idSchema },
  // Strategy management (closes #14)
  pause_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/pause`, schema: idSchema },
  resume_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/resume`, schema: idSchema },
  fork_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/fork`, schema: idSchema },
  delete_strategy: { method: "DELETE", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  import_strategy: { method: "POST", path: "/api/v1/strategies/import", body: (a) => importStrategySchema.parse(a).data },
  // Trading tools (closes #15)
  redeem_position: { method: "POST", path: "/api/v1/orders/redeem", body: (a) => redeemPositionSchema.parse(a) },
  split_position: { method: "POST", path: "/api/v1/orders/split", body: (a) => splitPositionSchema.parse(a) },
  merge_position: { method: "POST", path: "/api/v1/orders/merge", body: (a) => mergePositionSchema.parse(a) },
  get_marketplace_listing: { method: "GET", path: (a) => `/api/v1/marketplace/${encodeURIComponent(String(a.id))}`, schema: idSchema },
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

// ─── SSRF-safe webhook URL validation ─────────────────────────────

/**
 * Validates a webhook URL against SSRF attacks.
 * Returns an error message string if the URL is unsafe, or null if it's OK.
 *
 * Performs DNS resolution for domain-based URLs to catch DNS rebinding attacks
 * where a domain initially resolves to a public IP but is later changed to
 * point to an internal address.
 *
 * **Note:** This is a client-side best-effort check.  The server must
 * independently validate resolved IPs at connection time.
 */
async function validateWebhookUrl(rawUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "Error: Invalid webhook URL.";
  }

  // Require HTTPS
  if (parsed.protocol !== "https:") {
    return "Error: Webhook URL must use HTTPS.";
  }

  // Block credentials in URL
  if (parsed.username || parsed.password) {
    return "Error: Webhook URL must not contain credentials.";
  }

  const host = parsed.hostname.toLowerCase();

  // Strip IPv6 brackets for analysis
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  // Block cloud metadata endpoints (with and without port)
  const metadataHosts = ["169.254.169.254", "metadata.google.internal", "metadata.google"];
  if (metadataHosts.includes(bare)) {
    return "Error: Webhook URL cannot point to cloud metadata endpoints.";
  }

  // Check if the host looks like an IPv4 address
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipv4Match = bare.match(ipv4Regex);
  if (ipv4Match) {
    const octets = [
      parseInt(ipv4Match[1], 10),
      parseInt(ipv4Match[2], 10),
      parseInt(ipv4Match[3], 10),
      parseInt(ipv4Match[4], 10),
    ];
    if (isPrivateIPv4(octets)) {
      return "Error: Webhook URL cannot point to private or internal addresses.";
    }
    // Literal IP — no DNS resolution needed
    return null;
  }

  // Check IPv6 addresses
  if (bare.includes(":") || isIP(bare) === 6) {
    if (isPrivateIPv6(bare)) {
      return "Error: Webhook URL cannot point to private or internal addresses.";
    }
    // Literal IP — no DNS resolution needed
    return null;
  }

  // --- Hostname checks (before DNS resolution) ---

  // Block well-known private/loopback hostnames
  const blockedHostnames = ["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"];
  if (blockedHostnames.includes(bare)) {
    return "Error: Webhook URL cannot point to private or internal addresses.";
  }

  // Block .local, .internal, and .localhost TLDs (DNS rebinding vectors)
  if (bare.endsWith(".local") || bare.endsWith(".internal") || bare.endsWith(".localhost")) {
    return "Error: Webhook URL cannot point to private or internal addresses.";
  }

  // --- DNS resolution: resolve domain and check all IPs ---
  // This mitigates DNS rebinding attacks where a domain initially resolves to
  // a public IP but is later changed to point to an internal address.
  const ipv4Addrs = await resolve4(bare).catch(() => [] as string[]);
  const ipv6Addrs = await resolve6(bare).catch(() => [] as string[]);
  const allAddrs = [...ipv4Addrs, ...ipv6Addrs];

  if (allAddrs.length === 0) {
    return "Error: Webhook URL hostname did not resolve to any address.";
  }

  for (const addr of allAddrs) {
    // Check resolved IPv4 addresses
    const v4Match = addr.match(ipv4Regex);
    if (v4Match) {
      const octets = [
        parseInt(v4Match[1], 10),
        parseInt(v4Match[2], 10),
        parseInt(v4Match[3], 10),
        parseInt(v4Match[4], 10),
      ];
      if (isPrivateIPv4(octets)) {
        return "Error: Webhook URL resolves to a private or loopback address.";
      }
    }

    // Check resolved IPv6 addresses
    if (addr.includes(":")) {
      if (isPrivateIPv6(addr)) {
        return "Error: Webhook URL resolves to a private or loopback address.";
      }
    }
  }

  return null;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b, c, d] = octets;
  // Validate range
  if (octets.some((o) => o < 0 || o > 255)) return true; // invalid = block
  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.88.99.0/24 (6to4 relay)
  if (a === 192 && b === 88 && c === 99) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved)
  if (a >= 224) return true;
  // 255.255.255.255 (broadcast)
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const normalized = addr.toLowerCase();
  // Unspecified (::)
  if (normalized === "::" || normalized === "0000:0000:0000:0000:0000:0000:0000:0000") return true;
  // Loopback (::1)
  if (normalized === "::1" || normalized === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
  // Link-local (fe80::/10)
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe80")) return true;
  // Unique local (fc00::/7 — fc00::/8 and fd00::/8)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  // IPv4-mapped IPv6 (::ffff:x.x.x.x) — check the embedded IPv4 (dotted-decimal form)
  const v4MappedMatch = normalized.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4MappedMatch) {
    const octets = [
      parseInt(v4MappedMatch[1], 10),
      parseInt(v4MappedMatch[2], 10),
      parseInt(v4MappedMatch[3], 10),
      parseInt(v4MappedMatch[4], 10),
    ];
    return isPrivateIPv4(octets);
  }
  // IPv4-mapped IPv6 hex-word form (::ffff:7f00:1) — Node.js normalizes to this
  const v4MappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex) {
    const high = parseInt(v4MappedHex[1], 16);
    const low = parseInt(v4MappedHex[2], 16);
    const octets = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
    return isPrivateIPv4(octets);
  }
  return false;
}

// ─── Handlers ──────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const apiUrl = process.env.POLYFORGE_API_URL || "https://localhost:3002";
  const isLocalhostFallback = !process.env.POLYFORGE_API_URL;

  if (isLocalhostFallback) {
    console.error(
      "[polyforge-mcp] WARNING: POLYFORGE_API_URL is not set — falling back to https://localhost:3002. " +
      "Production deployments MUST set POLYFORGE_API_URL to the real API endpoint (e.g. https://api.polyforge.app). " +
      "Using localhost with HTTPS requires a trusted certificate; do NOT set NODE_TLS_REJECT_UNAUTHORIZED=0 as a workaround."
    );
  }

  // Validate API URL — reject non-HTTPS for non-localhost hosts
  const parsedApiUrl = new URL(apiUrl);
  if (
    parsedApiUrl.protocol !== "https:" &&
    parsedApiUrl.hostname !== "localhost" &&
    parsedApiUrl.hostname !== "127.0.0.1"
  ) {
    return {
      content: [{ type: "text", text: "Error: POLYFORGE_API_URL must use HTTPS for non-localhost hosts." }],
      isError: true,
    };
  }
  const apiKey = process.env.POLYFORGE_API_KEY;

  if (!apiKey) {
    return {
      content: [{ type: "text", text: "Error: POLYFORGE_API_KEY environment variable is not set. Generate an API key in Polyforge Settings > API Keys." }],
      isError: true,
    };
  }

  // ── get_strategy_events: SSE polling (collect N events then return) ──────
  if (name === "get_strategy_events") {
    await acquireRateLimitToken();
    const validated = getStrategyEventsSchema.parse(args);
    const { id, after_timestamp, limit } = validated;
    const cap = Math.min(limit, 100);
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

  // Validate webhook URL before forwarding to prevent SSRF
  if (name === "create_webhook") {
    const webhookUrl = (args as Record<string, unknown>).url;
    if (typeof webhookUrl === "string") {
      const ssrfError = await validateWebhookUrl(webhookUrl);
      if (ssrfError) {
        return { content: [{ type: "text", text: ssrfError }], isError: true };
      }
    }
  }

  try {
    const result = await callApi(apiUrl, apiKey, route, args as Record<string, unknown>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return {
        content: [{ type: "text", text: `Validation error: ${issues}` }],
        isError: true,
      };
    }
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
  // Arm a 30-second wall-clock timeout to prevent indefinite hangs
  const timeout = setTimeout(() => controller.abort(), 30_000);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
    signal: controller.signal,
  });

  if (!res.ok) {
    clearTimeout(timeout);
    const raw = await res.text().catch(() => "");
    // Truncate error body to avoid information disclosure
    const sanitized = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
    throw new Error(`${res.status} ${res.statusText}: ${sanitized}`);
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
    clearTimeout(timeout);
    controller.abort();
    reader.cancel().catch(() => undefined);
  }

  return { events, nextAfterTimestamp: nextTs };
}

// ─── Rate limiter (token bucket with async mutex) ────────────────
// Wrap token consumption in a promise-chain mutex so concurrent MCP
// tool invocations cannot read the same token count before deduction.

const RATE_LIMIT_TOKENS_PER_SEC = 10;
const RATE_LIMIT_MAX_TOKENS = 20;
let rateLimitTokens = RATE_LIMIT_MAX_TOKENS;
let rateLimitLastRefill = Date.now();
let rateLimitMutex: Promise<void> = Promise.resolve();

function doAcquireToken(): Promise<void> {
  const now = Date.now();
  const elapsed = (now - rateLimitLastRefill) / 1000;
  rateLimitTokens = Math.min(RATE_LIMIT_MAX_TOKENS, rateLimitTokens + elapsed * RATE_LIMIT_TOKENS_PER_SEC);
  rateLimitLastRefill = now;

  if (rateLimitTokens < 1) {
    const waitMs = ((1 - rateLimitTokens) / RATE_LIMIT_TOKENS_PER_SEC) * 1000;
    return new Promise((r) => setTimeout(r, waitMs)).then(() => {
      rateLimitTokens = 0;
      rateLimitLastRefill = Date.now();
    });
  } else {
    rateLimitTokens -= 1;
    return Promise.resolve();
  }
}

async function acquireRateLimitToken(): Promise<void> {
  const ticket = rateLimitMutex.then(() => doAcquireToken());
  rateLimitMutex = ticket.then(() => undefined, () => undefined);
  return ticket;
}

// ─── API client ────────────────────────────────────────────────────

const MAX_RETRIES = 3;

async function callApi(
  baseUrl: string,
  apiKey: string,
  route: RouteConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Validate inputs against the route schema before processing (#48, #49)
  if (route.schema) {
    route.schema.parse(args);
  }

  const path = typeof route.path === "function" ? route.path(args) : route.path;
  const url = new URL(path, baseUrl);

  if (route.query) {
    const params = route.query(args);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await acquireRateLimitToken();

    const res = await fetch(url.toString(), {
      method: route.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: route.body ? JSON.stringify(route.body(args)) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Math.min(Number(res.headers.get("retry-after") || "0"), 60);
      const backoffMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 8000);
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      // Truncate error body to prevent information disclosure
      const sanitized = raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
      throw new Error(`${res.status} ${res.statusText}: ${sanitized}`);
    }

    if (res.status === 204) {
      return { success: true };
    }
    return res.json();
  }

  throw new Error("Rate limited: max retries exceeded");
}

// ─── Start ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport);
