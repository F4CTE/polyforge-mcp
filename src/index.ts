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

// ─── Environment constants (validated at startup) ────────────────
// Read once at module load; startup guard below rejects missing key.

const POLYFORGE_API_URL = process.env.POLYFORGE_API_URL || "https://localhost:3002";
const POLYFORGE_API_KEY = process.env.POLYFORGE_API_KEY;

// ─── SSE safety constant ────────────────────────────────────────
// Maximum bytes buffered from an SSE stream before aborting.
const MAX_SSE_BUFFER_SIZE = 1_048_576; // 1 MB

// ─── Input validation schemas (Zod) ──────────────────────────────
// Validates all tool inputs before forwarding to the backend API.

const boundedRecord = (maxKeys: number) =>
  z.record(z.string().max(100), z.unknown()).refine(
    (obj) => Object.keys(obj).length <= maxKeys,
    { message: `Record must have at most ${maxKeys} keys` },
  );

const blockSchema = z.object({
  id: z.string().optional(),
  type: z.string().max(100),
  config: boundedRecord(20).optional(),
});

const strategyVariableSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(50).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  expression: z.string().max(200),
});

const marketSlotSchema = z.object({
  slot: z.string(),
  label: z.string().optional(),
  defaultMarketId: z.string().optional(),
});

const createStrategySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  marketId: z.string().max(255).optional(),
  visibility: z.enum(["PRIVATE", "PUBLIC", "UNLISTED"]).optional(),
  execMode: z.enum(["TICK", "EVENT", "HYBRID"]).optional(),
  tickMs: z.number().int().min(200).max(60000).optional(),
  triggers: z.array(blockSchema).max(50).optional(),
  conditions: z.array(blockSchema).max(50).optional(),
  actions: z.array(blockSchema).max(50).optional(),
  safety: z.array(blockSchema).max(20).optional(),
  logicBlocks: z.array(blockSchema).max(50).optional(),
  calcBlocks: z.array(blockSchema).max(50).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  variables: z.array(strategyVariableSchema).max(20).optional(),
  canvas: z.object({
    positions: z.record(z.string().max(100), z.object({ x: z.number(), y: z.number() })).refine(
      (obj) => Object.keys(obj).length <= 200,
      { message: "Canvas positions must have at most 200 entries" },
    ).optional(),
    connections: z.array(z.object({ from: z.string().max(100), to: z.string().max(100) })).max(500).optional(),
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number().min(0.1).max(10) }).optional(),
  }).catchall(z.unknown()).refine(
    (obj) => Object.keys(obj).length <= 10,
    { message: "Canvas must have at most 10 top-level keys" },
  ).optional(),
  marketSlots: z.array(marketSlotSchema).max(20).optional(),
});

const createStrategyFromDescriptionSchema = z.object({
  description: z.string().min(1).max(5000),
  marketId: z.string().optional(),
});

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1).max(8),
});

const aiQuerySchema = z.object({
  query: z.string().min(1).max(500),
  context: z.string().max(500).optional(),
});

const placeOrderSchema = z.object({
  marketId: z.string().uuid(),
  tokenId: z.string().uuid(),
  side: z.enum(["BUY", "SELL"]),
  outcome: z.enum(["YES", "NO"]),
  size: z.number().positive().min(1),
  price: z.number().min(0.001).max(0.999),
  orderType: z.enum(["GTC", "GTD", "FOK", "FAK", "POST_ONLY"]).optional(),
});

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

// ─── Reusable numeric-string validators (#108) ────────────────────
// These validate fields the backend API accepts as decimal strings
// (e.g. USDC amounts, percentage rates) rather than JS numbers.

/** Accepts a positive decimal string such as "100.5" or "1000". */
const positiveDecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Must be a positive decimal number")
  .refine((v) => parseFloat(v) > 0, { message: "Must be greater than zero" });

/** Accepts a Polymarket probability price string: "0.001" – "0.999". */
const priceDecimalString = z
  .string()
  .regex(/^0\.\d+$/, "Must be a decimal probability string (e.g. '0.65')")
  .refine(
    (v) => { const n = parseFloat(v); return n >= 0.001 && n <= 0.999; },
    { message: "Price must be between 0.001 and 0.999" },
  );

/** Accepts a trailing-stop percentage string: positive decimal up to 100. */
const pctDecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Must be a positive decimal percentage")
  .refine((v) => parseFloat(v) > 0 && parseFloat(v) <= 100, {
    message: "Percentage must be between 0 and 100",
  });

const runBacktestSchema = z.object({
  strategyId: z.string().uuid(),
  dateRangeStart: z.string().regex(isoDateRegex, "Must be ISO 8601 date (YYYY-MM-DD)").optional(),
  dateRangeEnd: z.string().regex(isoDateRegex, "Must be ISO 8601 date (YYYY-MM-DD)").optional(),
  quickMode: z.boolean().optional(),
  // Concrete block structure prevents arbitrary payload forwarding (#110)
  strategyBlocks: z.object({
    triggers: z.array(blockSchema).max(50).optional(),
    conditions: z.array(blockSchema).max(50).optional(),
    actions: z.array(blockSchema).max(50).optional(),
    safety: z.array(blockSchema).max(20).optional(),
    logicBlocks: z.array(blockSchema).max(50).optional(),
    calcBlocks: z.array(blockSchema).max(50).optional(),
  }).optional(),
  marketBindings: z.record(z.string().max(100), z.string().uuid()).optional(),
});

const createAlertSchema = z.object({
  tokenId: z.string().uuid(),         // #107 — enforce UUID
  direction: z.enum(["above", "below"]),
  price: priceDecimalString,          // #108 — validate probability range
  persistent: z.boolean().optional(),
});

const updateStrategySchema = z.object({
  id: z.string().uuid(),
}).merge(createStrategySchema.partial());

const closePositionSchema = z.object({
  tokenId: z.string().uuid(),
  size: positiveDecimalString.optional(),  // #108 — validate positive decimal
});

const redeemPositionSchema = z.object({
  positionId: z.string().uuid().optional(),
  marketId: z.string().uuid().optional(),  // #107 — enforce UUID
});

const splitPositionSchema = z.object({
  tokenId: z.string().uuid(),      // #107 — enforce UUID
  amount: positiveDecimalString,   // #108 — validate positive decimal
});

const mergePositionSchema = z.object({
  tokenId: z.string().uuid(),      // #107 — enforce UUID
  amount: positiveDecimalString,   // #108 — validate positive decimal
});

const provideLiquiditySchema = z.object({
  marketId: z.string().uuid(),  // #119 — enforce UUID
  tokenId: z.string().uuid(),   // #119 — enforce UUID
  amountUsdc: z.number().positive(),
  targetSpread: z.number().min(0).max(1).optional(),
});

const startStrategySchema = z.object({
  id: z.string().uuid(),
  mode: z.enum(["live", "paper"]).default("paper"),
  deploymentMode: z.enum(["LIVE", "SIMULATION"]).optional(),
});

const importBlockSchema = blockSchema.omit({ id: true });

const importStrategySchema = z.object({
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
      positions: z.record(z.string().max(100), z.object({ x: z.number(), y: z.number() }))
        .refine(obj => Object.keys(obj).length <= 200, { message: "Too many positions (max 200)" })
        .optional(),
      connections: z.array(z.object({ from: z.string().max(100), to: z.string().max(100) })).max(500).optional(),
    }).optional(),
  }),
});

const isoDatetimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const createConditionalOrderSchema = z.object({
  marketId: z.string().uuid(),     // #107 — enforce UUID
  tokenId: z.string().uuid(),      // #107 — enforce UUID
  type: z.enum(["TAKE_PROFIT", "STOP_LOSS", "TRAILING_STOP", "LIMIT", "PEGGED"]),
  side: z.enum(["BUY", "SELL"]),
  outcome: z.enum(["YES", "NO"]),
  size: z.number().positive().min(1),
  triggerPrice: z.number().min(0.001).max(1),
  limitPrice: priceDecimalString.optional(),  // #108 — validate probability range
  trailingPct: pctDecimalString.optional(),   // #108 — validate percentage range
  expiresAt: z.string().regex(isoDatetimeRegex, "Must be ISO 8601 datetime").optional(),
});

const placeSmartOrderSchema = z.object({
  type: z.enum(["TWAP", "DCA", "BRACKET", "OCO"]),
  tokenId: z.string().uuid(),
  side: z.enum(["BUY", "SELL"]),
  outcome: z.enum(["YES", "NO"]),
  totalSize: z.number().positive().min(1),
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
const conditionIdSchema = z.object({ conditionId: z.string().min(1) });

const marketIdParamSchema = z.object({ marketId: z.string().uuid() });

// ─── Query parameter validation schemas (#49) ───────────────────
// Bounded limits, typed numerics, and constrained enums for all GET tools.

const listMarketsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: z.enum(["Sports", "Crypto", "Politics", "Science", "Culture"]).optional(),
  sort: z.enum(["popular", "newest", "volume"]).optional(),
  closed: z.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const listStrategiesQuerySchema = z.object({
  status: z.enum(["IDLE", "RUNNING", "PAUSED", "PAPER", "ERROR", "ARCHIVED"]).optional(),
  sort: z.enum(["createdAt", "updatedAt", "name", "status", "likeCount"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const getOrdersQuerySchema = z.object({
  status: z.string().max(50).optional(),
  strategyId: z.string().uuid().optional(),
  marketId: z.string().uuid().optional(),
  from: z.string().max(50).optional(),
  to: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const whaleFeedQuerySchema = z.object({
  minSize: z.coerce.number().min(0).optional(),
  marketId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const newsSignalsQuerySchema = z.object({
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  marketId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const portfolioPnlQuerySchema = z.object({
  period: z.enum(["7d", "30d", "90d", "allTime"]).optional(),
  strategyId: z.string().uuid().optional(),
});

const listBacktestsQuerySchema = z.object({
  strategyId: z.string().uuid().optional(),
  status: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const listConditionalOrdersQuerySchema = z.object({
  status: z.string().max(50).optional(),
  type: z.enum(["TAKE_PROFIT", "STOP_LOSS", "TRAILING_STOP", "LIMIT", "PEGGED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
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

// ─── New tool schemas (closes #66) ──────────────────────────────

const discoverStrategiesSchema = z.object({
  sort: z.enum(["popular", "newest", "top_pnl", "most_forked"]).optional(),
  category: z.string().max(100).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const leaderboardQuerySchema = z.object({
  period: z.enum(["7d", "30d", "allTime"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const topWhalesQuerySchema = z.object({
  sortBy: z.enum(["volume", "pnl", "winRate", "tradeCount"]).optional(),
  period: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const whaleAddressSchema = z.object({
  address: z.string().min(1).max(100),
});

const createMarketplaceListingSchema = z.object({
  strategyId: z.string().uuid(),
  title: z.string().min(1).max(200),
  priceUsdc: z.number().positive(),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
});

const updateMarketplaceListingSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  price: z.number().positive().optional(),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

const rateMarketplaceListingSchema = z.object({
  id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  review: z.string().max(2000).optional(),
});

const createCopyConfigSchema = z.object({
  targetWallet: z.string().min(1).max(100),
  mode: z.enum(["PERCENTAGE", "FIXED", "MIRROR"]).optional(),
  sizeValue: z.number().positive().optional(),
  maxExposure: z.number().positive().optional(),
  maxDailyLoss: z.number().positive().optional(),
  priceOffset: z.number().optional(),
});

const updateCopyConfigSchema = z.object({
  id: z.string().uuid(),
  mode: z.enum(["PERCENTAGE", "FIXED", "MIRROR"]).optional(),
  sizeValue: z.number().positive().optional(),
  maxExposure: z.number().positive().optional(),
  maxDailyLoss: z.number().positive().optional(),
  priceOffset: z.number().optional(),
});

// #121 — restrict batch paths to user-facing /api/v1/ endpoints only
const BATCH_PATH_RE = /^\/api\/v1\/[a-zA-Z0-9\-._~!$&'()*+,;=:@]+(?:\/[a-zA-Z0-9\-._~!$&'()*+,;=:@]*)*\/?$/;

const batchRequestItemSchema = z.object({
  id: z.string().min(1).max(100),
  method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
  path: z.string().min(1).max(500)
    .regex(BATCH_PATH_RE, "Path must be a user-facing /api/v1/ route")
    .refine((p) => !p.includes(".."), { message: "Path must not contain traversal sequences" }),
  body: boundedRecord(50).optional(),
});

const batchRequestsSchema = z.object({
  requests: z.array(batchRequestItemSchema).min(1).max(10),
});

// ─── POLA-104 compat fix schemas ──────────────────────────────────

const getPriceHistorySchema = z.object({
  tokenId: z.string().min(1).max(200),
  resolution: z.enum(["1m", "1h", "1d"]).optional(),
  from: z.string().max(50).optional(),
  to: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const addStrategyCommentSchema = z.object({
  id: z.string().uuid(),
  content: z.string().min(1).max(2000),
});

const deleteStrategyCommentSchema = z.object({
  id: z.string().uuid(),
  commentId: z.string().uuid(),
});

const reportStrategySchema = z.object({
  id: z.string().uuid(),
  reason: z.enum(["SPAM", "HARMFUL", "MISLEADING", "OTHER"]),
  description: z.string().max(1000).optional(),
});

const rollbackStrategySchema = z.object({
  id: z.string().uuid(),
  versionId: z.string().uuid(),
});

const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  expiresAt: z.string().max(50).optional(),
  scopes: z.array(z.enum(["READ", "WRITE", "TRADE", "STRATEGY", "WEBHOOK"])).max(5).optional(),
});

const updateRiskSettingsSchema = z.object({
  drawdownEnabled: z.boolean().optional(),
  drawdownLookbackHours: z.number().int().min(1).max(168).optional(),
  drawdownThresholdPct: z.number().min(0.01).max(0.99).optional(),
});

// ─── POLA-297 missing platform endpoint schemas ─────────────────────

const searchMarketsSchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const tokenIdParamSchema = z.object({
  tokenId: z.string().min(1).max(200),
});

const clobPricesHistorySchema = z.object({
  tokenId: z.string().min(1).max(200),
  interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional(),
  fidelity: z.coerce.number().int().min(1).max(1440).optional(),
  startTs: z.coerce.number().int().optional(),
  endTs: z.coerce.number().int().optional(),
});

const placeBatchOrdersSchema = z.object({
  orders: z.array(z.object({
    tokenId: z.string().uuid(),
    side: z.enum(["BUY", "SELL"]),
    outcome: z.enum(["YES", "NO"]),
    size: z.number().positive().min(1),
    price: z.number().min(0.001).max(0.999),
    orderType: z.enum(["GTC", "GTD", "FOK"]).optional(),
  })).min(1).max(15),
});

const cancelOrdersBulkSchema = z.object({
  orderIds: z.array(z.string().uuid()).min(1).max(3000),
});

const listNewsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const newsArticleIdSchema = z.object({
  id: z.string().min(1).max(100),
});

const topScoresSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const userIdParamSchema = z.object({
  userId: z.string().min(1).max(200),
});

const polymarketPortfolioSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

const polymarketActivitySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
});

// ─── POLA-790 Phase A: Cross-venue arbitrage + whale alert schemas ──

const crossVenueQuerySchema = z.object({
  minSpread: z.coerce.number().min(0).optional(),
});

const matchIdParamSchema = z.object({
  matchId: z.string().min(1).max(200),
});

const listMatchesQuerySchema = z.object({
  verified: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createMatchSchema = z.object({
  polymarketId: z.string().min(1).max(255),
  kalshiId: z.string().min(1).max(255),
});

const smartMoneyLeaderboardSchema = z.object({
  period: z.enum(["24h", "7d", "30d", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const upsertWhaleAlertFilterSchema = z.object({
  minSize: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  marketIds: z.array(z.string().max(255)).max(50).optional(),
  walletAddresses: z.array(z.string().max(255)).max(100).optional(),
  sides: z.array(z.enum(["BUY", "SELL"])).max(2).optional(),
  active: z.boolean().optional(),
});


// ─── POLA-792 user management schemas ───────────────────────────────

const updateMyProfileSchema = z.object({
  displayName: z.string().max(50).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().max(2048).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

const updateProfileNotificationsSchema = z.object({}).catchall(z.boolean());

const usernameParamSchema = z.object({
  username: z.string().min(1).max(100),
});

const updateSettingsProfileSchema = z.object({
  displayName: z.string().max(100).optional(),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().max(2048).optional(),
  twitterHandle: z.string().max(50).optional(),
});

const updateSettingsNotificationsSchema = z.object({
  emailEnabled: z.boolean().optional(),
  telegramEnabled: z.boolean().optional(),
  discordEnabled: z.boolean().optional(),
  onOrderFilled: z.boolean().optional(),
  onStrategyError: z.boolean().optional(),
  onBacktestComplete: z.boolean().optional(),
  onDailyLossLimit: z.boolean().optional(),
  onMarketResolved: z.boolean().optional(),
  onSomeoneForked: z.boolean().optional(),
  onSomeoneFollowed: z.boolean().optional(),
  onSomeoneLiked: z.boolean().optional(),
  onSomeoneCommented: z.boolean().optional(),
});

const updateSettingsPasswordSchema = z.object({
  currentPassword: z.string().min(8).max(100),
  newPassword: z.string().min(8).max(100).regex(/(?=.*[A-Z])(?=.*[a-z])(?=.*\d)/),
});

const createTicketSchema = z.object({
  subject: z.string().min(1).max(255),
  category: z.enum(["GENERAL", "BILLING", "TECHNICAL", "ACCOUNT", "BUG", "FEATURE_REQUEST"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  body: z.string().min(1).max(5000),
});

const listTicketsSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const ticketIdSchema = z.object({
  id: z.string().uuid(),
});

const addTicketMessageSchema = z.object({
  id: z.string().uuid(),
  body: z.string().min(1).max(5000),
});

const updateEventNotificationsSchema = z.object({
  preferences: z.array(z.object({
    event: z.string().min(1).max(100),
    inApp: z.boolean().optional(),
    email: z.boolean().optional(),
    push: z.boolean().optional(),
  })).max(50).optional(),
  emailDigest: z.string().max(20).optional(),
});

const updateVenuePreferencesSchema = z.object({
  defaultVenue: z.string().max(50).optional(),
  enabledVenues: z.array(z.string().max(50)).min(1).max(20).optional(),
  singlePlatformMode: z.boolean().optional(),
});

const server = new Server(
  { name: "polyforge", version: "1.13.0" },
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
        sort: { type: "string", enum: ["popular", "newest", "volume"], description: "Sort order (default: popular)" },
        closed: { type: "boolean", description: "Include resolved/closed markets (default: false)" },
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
    description: "List your trading strategies with optional status filter, sorting, and pagination",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["IDLE", "RUNNING", "PAUSED", "PAPER", "ERROR", "ARCHIVED"], description: "Filter by strategy status" },
        sort: { type: "string", enum: ["createdAt", "updatedAt", "name", "status", "likeCount"], description: "Sort order (default: createdAt)" },
        limit: { type: "number", description: "Max results per page (default 20, max 100)" },
        page: { type: "number", description: "Page number (default 1)" },
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
    description: "Create a new trading strategy with blocks, execution mode, visibility, and tags",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Strategy name (max 100 chars)" },
        description: { type: "string", description: "Strategy description (max 500 chars)" },
        marketId: { type: "string", description: "Market ID to pin this strategy to" },
        visibility: { type: "string", enum: ["PRIVATE", "PUBLIC", "UNLISTED"], description: "Strategy visibility (default: PRIVATE)" },
        execMode: { type: "string", enum: ["TICK", "EVENT", "HYBRID"], description: "Execution mode (default: TICK)" },
        tickMs: { type: "number", description: "Tick interval in ms (200-60000, default: 1000)" },
        triggers: { type: "array", items: { type: "object" }, description: "Trigger blocks — when to evaluate the strategy" },
        conditions: { type: "array", items: { type: "object" }, description: "Condition blocks — what must be true" },
        actions: { type: "array", items: { type: "object" }, description: "Action blocks — what to do (place orders, etc.)" },
        safety: { type: "array", items: { type: "object" }, description: "Safety blocks — circuit breakers and limits" },
        logicBlocks: { type: "array", items: { type: "object" }, description: "Logic blocks — AND/OR/NOT combinators" },
        calcBlocks: { type: "array", items: { type: "object" }, description: "Calculation blocks — computed values" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for organization (max 20)" },
        variables: { type: "array", items: { type: "object" }, description: "Strategy variables with name and expression (max 20)" },
        canvas: { type: "object", description: "Canvas layout metadata for the visual builder" },
        marketSlots: { type: "array", items: { type: "object" }, description: "Parameterized market bindings" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_strategy",
    description: "Update a strategy's configuration — blocks, execution mode, visibility, tags, and more",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
        name: { type: "string", description: "Strategy name (max 100 chars)" },
        description: { type: "string", description: "Strategy description (max 500 chars)" },
        marketId: { type: "string", description: "Market ID to pin strategy to (empty string to unpin)" },
        visibility: { type: "string", enum: ["PRIVATE", "PUBLIC", "UNLISTED"], description: "Strategy visibility" },
        execMode: { type: "string", enum: ["TICK", "EVENT", "HYBRID"], description: "Execution mode" },
        tickMs: { type: "number", description: "Tick interval in ms (200-60000)" },
        triggers: { type: "array", items: { type: "object" }, description: "Trigger blocks" },
        conditions: { type: "array", items: { type: "object" }, description: "Condition blocks" },
        actions: { type: "array", items: { type: "object" }, description: "Action blocks" },
        safety: { type: "array", items: { type: "object" }, description: "Safety blocks" },
        logicBlocks: { type: "array", items: { type: "object" }, description: "Logic blocks" },
        calcBlocks: { type: "array", items: { type: "object" }, description: "Calculation blocks" },
        tags: { type: "array", items: { type: "string" }, description: "Tags (max 20)" },
        variables: { type: "array", items: { type: "object" }, description: "Strategy variables (max 20)" },
        canvas: { type: "object", description: "Canvas layout metadata" },
        marketSlots: { type: "array", items: { type: "object" }, description: "Parameterized market bindings" },
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
        deploymentMode: { type: "string", enum: ["LIVE", "SIMULATION"], description: "Optional deployment mode override sent to the platform — SIMULATION for paper, LIVE for real orders" },
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
        page: { type: "number", description: "Page number (default 1)" },
        status: { type: "string", description: "Filter by order status (e.g. FILLED, PENDING, CANCELLED)" },
        strategyId: { type: "string", description: "Filter orders by strategy UUID" },
        marketId: { type: "string", description: "Filter orders by market UUID" },
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
        marketId: { type: "string", description: "Filter whale trades by market UUID (optional)" },
        page: { type: "number", description: "Page number for pagination (default 1)" },
        limit: { type: "number", description: "Max results per page (default 20, max 100)" },
      },
    },
  },
  {
    name: "get_news_signals",
    description: "Get AI-generated trading signals derived from news articles",
    inputSchema: {
      type: "object" as const,
      properties: {
        minConfidence: { type: "number", description: "Minimum confidence score 0–1 (default 0.7)" },
        marketId: { type: "string", description: "Filter signals by market UUID (optional)" },
        page: { type: "number", description: "Page number for pagination (default 1)" },
        limit: { type: "number", description: "Max results per page (default 20, max 100)" },
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
    name: "delete_webhook",
    description: "Delete a registered webhook endpoint",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Webhook UUID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "test_webhook",
    description: "Send a test event payload to a registered webhook to verify delivery",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Webhook UUID to test" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_watchlist",
    description: "List your watched markets with current prices, 24h volume, and price delta",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "add_to_watchlist",
    description: "Add a market to your watchlist for monitoring",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: { type: "string", description: "Market UUID to add to watchlist" },
      },
      required: ["marketId"],
    },
  },
  {
    name: "remove_from_watchlist",
    description: "Remove a market from your watchlist",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: { type: "string", description: "Market UUID to remove from watchlist" },
      },
      required: ["marketId"],
    },
  },
  {
    name: "get_watchlist_status",
    description: "Check whether a specific market is on your watchlist",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: { type: "string", description: "Market UUID to check" },
      },
      required: ["marketId"],
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
        marketId: { type: "string", description: "Market UUID (from GET /markets)" },
        tokenId: { type: "string", description: "Token ID to trade (get from market details)" },
        side: { type: "string", enum: ["BUY", "SELL"], description: "Order side" },
        outcome: { type: "string", enum: ["YES", "NO"], description: "Market outcome to trade" },
        size: { type: "number", description: "Number of shares (minimum 1)" },
        price: { type: "number", description: "Limit price per share (0.001-0.999). Use 0.999 for market buy, 0.001 for market sell." },
        orderType: { type: "string", enum: ["GTC", "FOK", "GTD", "FAK", "POST_ONLY"], description: "Order type: GTC (good till cancel), FOK (fill or kill), GTD (good till date), FAK (fill and kill, partial fills allowed), POST_ONLY (maker-only, rejected if would cross). Default: GTC" },
      },
      required: ["marketId", "tokenId", "side", "outcome", "size", "price"],
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
        status: { type: "string", description: "Filter by backtest status (e.g. COMPLETED, RUNNING, FAILED)" },
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
        quickMode: { type: "boolean", description: "If true, run a faster approximate backtest (optional)" },
        strategyBlocks: { type: "object", description: "Override strategy block configuration for the backtest (optional)" },
        marketBindings: { type: "object", description: "Override market bindings for the backtest (optional)" },
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
        tokenId: { type: "string", description: "Token UUID to monitor" },
        direction: { type: "string", enum: ["above", "below"], description: "Alert when price goes above or below threshold" },
        price: { type: "string", description: "Price threshold as a decimal probability string between 0.001 and 0.999 (e.g. '0.65')" },
        persistent: { type: "boolean", description: "If true, alert re-arms after triggering (default false)" },
      },
      required: ["tokenId", "direction", "price"],
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
        tokenId: { type: "string", description: "Token UUID of the position to close" },
        size: { type: "string", description: "Size to close as a positive decimal string (optional, defaults to full position)" },
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
        type: { type: "string", enum: ["TAKE_PROFIT", "STOP_LOSS", "TRAILING_STOP", "LIMIT", "PEGGED"], description: "Filter by order type" },
        limit: { type: "number", description: "Max results (default 20)" },
        page: { type: "number", description: "Page number (default 1)" },
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
        tokenId: { type: "string", description: "Token UUID for the outcome to trade" },
        type: { type: "string", enum: ["TAKE_PROFIT", "STOP_LOSS", "TRAILING_STOP", "LIMIT", "PEGGED"], description: "Conditional order type" },
        side: { type: "string", enum: ["BUY", "SELL"], description: "Order side when triggered" },
        outcome: { type: "string", enum: ["YES", "NO"], description: "Which outcome to trade" },
        size: { type: "number", description: "Number of shares (minimum 1)" },
        triggerPrice: { type: "number", description: "Price that triggers the order (0.001-1)" },
        limitPrice: { type: "string", description: "Limit price as probability decimal string 0.001–0.999 (optional)" },
        trailingPct: { type: "string", description: "Trailing percentage 0–100 as decimal string for TRAILING_STOP type (optional)" },
        expiresAt: { type: "string", description: "ISO 8601 expiration datetime (optional, e.g. '2025-12-31T23:59:59Z')" },
      },
      required: ["marketId", "tokenId", "type", "side", "outcome", "size", "triggerPrice"],
    },
  },
  {
    name: "get_conditional_order",
    description: "Get details of a specific conditional order (take-profit, stop-loss, trailing stop, etc.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Conditional order UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "cancel_conditional_order",
    description: "Cancel a pending conditional order",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Conditional order UUID to cancel" },
      },
      required: ["id"],
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
    description: "Provide liquidity to a market by depositing USDC.e",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: { type: "string", description: "Market condition ID to provide liquidity for" },
        tokenId: { type: "string", description: "Token ID (YES or NO side) to provide liquidity on" },
        amountUsdc: { type: "number", description: "Amount of USDC.e to deposit as liquidity" },
        targetSpread: { type: "number", description: "Target bid-ask spread (0–1, optional)" },
      },
      required: ["marketId", "tokenId", "amountUsdc"],
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
    description: "Import a strategy from a .polyforge JSON export. Creates a new strategy in your account. Pass the top-level polyforge version string and strategy object directly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        polyforge: { type: "string", description: "Export format version (e.g. '1.0')" },
        exportedAt: { type: "string", description: "ISO timestamp of export (optional)" },
        strategy: {
          type: "object",
          description: "Strategy definition with name, description, execMode, tickMs, visibility, tags, variables, blocks, and canvas",
        },
      },
      required: ["polyforge", "strategy"],
    },
  },
  // ── Trading tools (closes #15) ──────────────────────────────────────
  {
    name: "redeem_position",
    description: "Redeem winning shares after a market resolves. Converts resolved YES/NO shares back to USDC.",
    inputSchema: {
      type: "object" as const,
      properties: {
        positionId: { type: "string", description: "Position UUID to redeem (optional if marketId is provided)" },
        marketId: { type: "string", description: "Market UUID to redeem all resolved positions for (optional if positionId is provided)" },
      },
    },
  },
  {
    name: "split_position",
    description: "Split USDC.e collateral into YES and NO outcome tokens for a market.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Token UUID of the market to split into" },
        amount: { type: "string", description: "Amount of USDC.e to split as positive decimal string (e.g. '100.5')" },
      },
      required: ["tokenId", "amount"],
    },
  },
  {
    name: "merge_position",
    description: "Merge YES and NO outcome tokens back into USDC.e collateral.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Token UUID of the market to merge from" },
        amount: { type: "string", description: "Amount of token pairs to merge as positive decimal string (e.g. '100.5')" },
      },
      required: ["tokenId", "amount"],
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
  // ── Discovery & Ranking (closes #66) ────────────────────────────────
  {
    name: "discover_strategies",
    description: "Discover and browse public strategies published by the community. Returns paginated results with sort, category, and search filters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sort: { type: "string", enum: ["popular", "newest", "top_pnl", "most_forked"], description: "Sort order (default: popular)" },
        category: { type: "string", description: "Category filter (e.g. crypto, politics, sports)" },
        search: { type: "string", description: "Search query to filter strategies by title or description" },
        limit: { type: "number", description: "Max results per page (default 20, max 100)" },
        page: { type: "number", description: "Page number for pagination (default 1)" },
      },
    },
  },
  {
    name: "get_leaderboard",
    description: "Get the top trader leaderboard ranked by P&L for a given time period.",
    inputSchema: {
      type: "object" as const,
      properties: {
        period: { type: "string", enum: ["7d", "30d", "allTime"], description: "Time period (default: 30d)" },
        limit: { type: "number", description: "Max results (default 20, max 100)" },
        page: { type: "number", description: "Page number for pagination (default 1)" },
      },
    },
  },
  // ── Paper Trading (closes #66) ─────────────────────────────────────
  {
    name: "get_paper_summary",
    description: "Get your paper trading account summary — virtual balance, P&L, open positions, and performance metrics.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "reset_paper_account",
    description: "Reset your paper trading account to its initial virtual balance. All paper positions and history are cleared.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  // ── Batch API (closes #66) ─────────────────────────────────────────
  {
    name: "batch_requests",
    description: "Execute multiple API requests in a single call. Useful for reading several resources at once or chaining related operations with minimal round-trips.",
    inputSchema: {
      type: "object" as const,
      properties: {
        requests: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Client-supplied request identifier echoed in the response" },
              method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"], description: "HTTP method" },
              path: { type: "string", description: "API path, e.g. /api/v1/strategies" },
              body: { type: "object", description: "Request body for POST/PATCH (optional)" },
            },
            required: ["id", "method", "path"],
          },
          description: "Array of requests to execute (max 10)",
        },
      },
      required: ["requests"],
    },
  },
  // ── Extended Whale Intelligence (closes #66) ───────────────────────
  {
    name: "get_top_whales",
    description: "Get the top whale traders ranked by volume, P&L, win rate, or trade count for a given time period.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sortBy: { type: "string", enum: ["volume", "pnl", "winRate", "tradeCount"], description: "Ranking metric (default: volume)" },
        period: { type: "string", description: "Time period filter (e.g. 7d, 30d, allTime)" },
        limit: { type: "number", description: "Number of results to return (1–100, default: 20)" },
      },
    },
  },
  {
    name: "get_whale_profile",
    description: "Get the full trading profile for a specific whale wallet address — history, open positions, and performance stats.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address of the whale" },
      },
      required: ["address"],
    },
  },
  {
    name: "follow_whale",
    description: "Follow a whale wallet to receive their trades in your whale feed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address of the whale to follow" },
      },
      required: ["address"],
    },
  },
  {
    name: "unfollow_whale",
    description: "Unfollow a whale wallet — their trades will no longer appear in your feed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address of the whale to unfollow" },
      },
      required: ["address"],
    },
  },
  {
    name: "get_followed_whales",
    description: "List all whale wallets you are currently following.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  // ── Marketplace Seller CRUD (closes #66) ───────────────────────────
  {
    name: "create_marketplace_listing",
    description: "Publish one of your strategies to the Polyforge Strategy Marketplace. Set a price and optional description for buyers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        strategyId: { type: "string", description: "UUID of the strategy to list" },
        title: { type: "string", description: "Listing title shown to buyers (max 200 chars)" },
        priceUsdc: { type: "number", description: "Listing price in USDC (must be positive)" },
        description: { type: "string", description: "Marketplace description shown to buyers (max 1000 chars, optional)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for discoverability (max 20, optional)" },
      },
      required: ["strategyId", "title", "priceUsdc"],
    },
  },
  {
    name: "update_marketplace_listing",
    description: "Update the title, price, description, or tags of one of your marketplace listings.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Marketplace listing UUID" },
        title: { type: "string", description: "Updated listing title (max 200 chars, optional)" },
        price: { type: "number", description: "New listing price in USDC (optional)" },
        description: { type: "string", description: "Updated description (max 1000 chars, optional)" },
        tags: { type: "array", items: { type: "string" }, description: "Updated tags for discoverability (max 20, optional)" },
      },
      required: ["id"],
    },
  },
  {
    name: "rate_marketplace_listing",
    description: "Rate and review a marketplace strategy you have purchased. Rating must be between 1 and 5.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Marketplace listing UUID to rate" },
        rating: { type: "number", description: "Star rating from 1 (lowest) to 5 (highest)" },
        review: { type: "string", description: "Written review (max 2000 chars, optional)" },
      },
      required: ["id", "rating"],
    },
  },
  {
    name: "get_my_listings",
    description: "List all marketplace strategies you have published as a seller, with sales count and revenue.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_my_purchases",
    description: "List all marketplace strategies you have purchased, including your forked copies.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  // ── Copy Trading CRUD (closes #66) ─────────────────────────────────
  {
    name: "create_copy_config",
    description: "Create a new copy trading configuration to automatically mirror trades from a target wallet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        targetWallet: { type: "string", description: "Wallet address to copy trades from" },
        mode: { type: "string", enum: ["PERCENTAGE", "FIXED", "MIRROR"], description: "Position sizing mode: PERCENTAGE (copy X% of source trade size), FIXED (fixed USDC amount per trade), or MIRROR (mirrors target's position size)" },
        sizeValue: { type: "number", description: "Percentage of source trade size (PERCENTAGE mode) or fixed USDC amount per trade (FIXED mode)" },
        maxExposure: { type: "number", description: "Maximum total USDC exposure across all copied positions (optional)" },
        maxDailyLoss: { type: "number", description: "Maximum daily loss in USDC before copy trading is paused (optional)" },
        priceOffset: { type: "number", description: "Price slippage offset to apply when entering copied trades (optional)" },
      },
      required: ["targetWallet"],
    },
  },
  {
    name: "get_copy_config",
    description: "Get details of a specific copy trading configuration including status, target wallet, and risk limits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Copy config UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "update_copy_config",
    description: "Update the sizing mode, risk limits, or price offset for an existing copy trading configuration.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Copy config UUID" },
        mode: { type: "string", enum: ["PERCENTAGE", "FIXED", "MIRROR"], description: "Position sizing mode" },
        sizeValue: { type: "number", description: "Percentage of source trade size (PERCENTAGE) or fixed USDC amount (FIXED)" },
        maxExposure: { type: "number", description: "Maximum total USDC exposure (optional)" },
        maxDailyLoss: { type: "number", description: "Maximum daily loss limit in USDC (optional)" },
        priceOffset: { type: "number", description: "Price offset for copied entries (optional)" },
      },
      required: ["id"],
    },
  },
  {
    name: "pause_copy_config",
    description: "Pause a copy trading configuration. No new trades will be copied until it is resumed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Copy config UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "resume_copy_config",
    description: "Resume a paused copy trading configuration.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Copy config UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_copy_config",
    description: "Permanently delete a copy trading configuration. Open positions copied from this config are NOT automatically closed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Copy config UUID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_copy_trades",
    description: "List all trades executed under a specific copy trading configuration.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Copy config UUID" },
      },
      required: ["id"],
    },
  },
  // ── Backtest Orders (closes #66) ────────────────────────────────────
  {
    name: "get_backtest_orders",
    description: "Get the simulated order log for a completed backtest — all fills, sizes, and prices generated during the backtest run.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Backtest UUID" },
      },
      required: ["id"],
    },
  },

  // ── Price history (#126) ──────────────────────────────────────────────────
  {
    name: "get_price_history",
    description: "Get historical price data for a market token. Supports candle resolutions of 1m, 1h, or 1d with optional date range filtering.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Polymarket token ID (numeric string or UUID)" },
        resolution: { type: "string", enum: ["1m", "1h", "1d"], description: "Candle resolution (default: 1h)" },
        from: { type: "string", description: "Start date/time in ISO 8601 format (e.g. 2026-01-01T00:00:00Z)" },
        to: { type: "string", description: "End date/time in ISO 8601 format (e.g. 2026-01-31T23:59:59Z)" },
        limit: { type: "number", description: "Max data points to return (default: 100, max: 1000)" },
      },
      required: ["tokenId"],
    },
  },

  // ── Strategy social (#126) ────────────────────────────────────────────────
  {
    name: "like_strategy",
    description: "Like a public strategy. Returns the updated like count.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID to like" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_strategy_comments",
    description: "List comments on a public strategy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
        page: { type: "number", description: "Page number (default: 1)" },
        limit: { type: "number", description: "Results per page (default: 20, max: 100)" },
      },
      required: ["id"],
    },
  },
  {
    name: "add_strategy_comment",
    description: "Post a comment on a public strategy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID to comment on" },
        content: { type: "string", description: "Comment text (max 2000 chars)" },
      },
      required: ["id", "content"],
    },
  },
  {
    name: "delete_strategy_comment",
    description: "Delete one of your own comments on a strategy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
        commentId: { type: "string", description: "Comment UUID to delete" },
      },
      required: ["id", "commentId"],
    },
  },
  {
    name: "list_strategy_children",
    description: "List strategies that were forked from a given strategy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
        page: { type: "number", description: "Page number (default: 1)" },
        limit: { type: "number", description: "Results per page (default: 20, max: 100)" },
      },
      required: ["id"],
    },
  },
  {
    name: "report_strategy",
    description: "Report a public strategy for violating community guidelines.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID to report" },
        reason: { type: "string", enum: ["SPAM", "HARMFUL", "MISLEADING", "OTHER"], description: "Reason category for the report" },
        description: { type: "string", description: "Additional details about the report (max 1000 chars, optional)" },
      },
      required: ["id", "reason"],
    },
  },

  // ── Strategy versioning (#126) ────────────────────────────────────────────
  {
    name: "list_strategy_versions",
    description: "List the saved version history of a strategy.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "rollback_strategy",
    description: "Roll a strategy back to a previously saved version.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
        versionId: { type: "string", description: "Version UUID to restore" },
      },
      required: ["id", "versionId"],
    },
  },

  // ── Strategy event log (#126) ─────────────────────────────────────────────
  {
    name: "get_strategy_event_log",
    description: "Get the persistent audit event log for a strategy (execution history, parameter changes, starts/stops).",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Strategy UUID" },
        page: { type: "number", description: "Page number (default: 1)" },
        limit: { type: "number", description: "Results per page (default: 20, max: 100)" },
      },
      required: ["id"],
    },
  },

  // ── API key management (#126) ─────────────────────────────────────────────
  {
    name: "list_api_keys",
    description: "List all API keys associated with your account.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "create_api_key",
    description: "Create a new API key for programmatic access.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Descriptive label for the key (max 100 chars)" },
        expiresAt: { type: "string", description: "Expiry in ISO 8601 format (optional — no expiry if omitted)" },
        scopes: { type: "array", items: { type: "string", enum: ["READ", "WRITE", "TRADE", "STRATEGY", "WEBHOOK"] }, description: "Permission scopes for this key (optional — defaults to READ only)" },
      },
      required: ["name"],
    },
  },
  {
    name: "revoke_api_key",
    description: "Permanently revoke an API key. This cannot be undone.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "API key UUID to revoke" },
      },
      required: ["id"],
    },
  },

  // ── Risk Settings (closes #132) ──────────────────────────────────────
  {
    name: "get_risk_settings",
    description: "Get the current risk / circuit-breaker settings for the authenticated user. Returns drawdown configuration and whether the circuit breaker is currently tripped.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "update_risk_settings",
    description: "Update risk settings. Only the supplied fields are changed. Use this to enable the drawdown circuit breaker, set the lookback window (1–168 hours), or change the threshold percentage (0.01–0.99).",
    inputSchema: {
      type: "object" as const,
      properties: {
        drawdownEnabled: { type: "boolean", description: "Enable or disable the drawdown circuit breaker" },
        drawdownLookbackHours: { type: "number", description: "Lookback window in hours (1–168, default 24)" },
        drawdownThresholdPct: { type: "number", description: "Drawdown threshold as a decimal, e.g. 0.10 = 10% (0.01–0.99, default 0.10)" },
      },
    },
  },
  {
    name: "reset_circuit_breaker",
    description: "Reset the circuit breaker after it has been tripped, allowing the strategy engine to place new orders. Returns the updated risk settings with circuitBreakerTripped: false.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // ── POLA-297: Missing platform endpoints ─────────────────────────────────

  // Markets — extended data (6)
  {
    name: "search_markets",
    description: "Search prediction markets by keyword. Returns matching markets with title, volume, and current prices.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search keyword or phrase (max 200 chars)" },
        limit: { type: "number", description: "Max results per page (default 10, max 100)" },
        page: { type: "number", description: "Page number (default 1)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_tick_size",
    description: "Get the minimum tick size (price increment) for a market token on the CLOB.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Market token ID" },
      },
      required: ["tokenId"],
    },
  },
  {
    name: "get_spread",
    description: "Get the current bid-ask spread for a market token on the CLOB.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Market token ID" },
      },
      required: ["tokenId"],
    },
  },
  {
    name: "get_midpoint",
    description: "Get the current midpoint price for a market token on the CLOB.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Market token ID" },
      },
      required: ["tokenId"],
    },
  },
  {
    name: "get_clob_book",
    description: "Get the full CLOB order book (bids and asks) for a market token.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Market token ID" },
      },
      required: ["tokenId"],
    },
  },
  {
    name: "get_clob_prices_history",
    description: "Get historical CLOB prices for a market token with configurable interval and time range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string", description: "Market token ID" },
        interval: { type: "string", enum: ["1m", "5m", "15m", "1h", "4h", "1d"], description: "Candle interval (default: 1h)" },
        fidelity: { type: "number", description: "Number of data points to return (default: 100, max: 1440)" },
        startTs: { type: "number", description: "Start timestamp (Unix seconds)" },
        endTs: { type: "number", description: "End timestamp (Unix seconds)" },
      },
      required: ["tokenId"],
    },
  },

  // Orders — bulk (2)
  {
    name: "place_batch_orders",
    description: "Place multiple orders in a single batch (1–15 orders). More efficient than looping single orders.",
    inputSchema: {
      type: "object" as const,
      properties: {
        orders: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tokenId: { type: "string", description: "Market token UUID" },
              side: { type: "string", enum: ["BUY", "SELL"], description: "Order side" },
              outcome: { type: "string", enum: ["YES", "NO"], description: "Token outcome" },
              size: { type: "number", description: "Order size in contracts (min 1)" },
              price: { type: "number", description: "Limit price (0.001–0.999)" },
              orderType: { type: "string", enum: ["GTC", "GTD", "FOK"], description: "Time-in-force (default: GTC)" },
            },
            required: ["tokenId", "side", "outcome", "size", "price"],
          },
          description: "Array of 1–15 orders to place",
        },
      },
      required: ["orders"],
    },
  },
  {
    name: "cancel_orders_bulk",
    description: "Cancel multiple orders in bulk (1–3000 order IDs). More efficient than cancelling one at a time.",
    inputSchema: {
      type: "object" as const,
      properties: {
        orderIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of 1–3000 order UUIDs to cancel",
        },
      },
      required: ["orderIds"],
    },
  },

  // News — articles (2)
  {
    name: "list_news",
    description: "List recent news articles relevant to prediction markets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max results per page (default 20, max 100)" },
        page: { type: "number", description: "Page number (default 1)" },
      },
    },
  },
  {
    name: "get_news_article",
    description: "Get the full content of a specific news article by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "News article ID" },
      },
      required: ["id"],
    },
  },

  // Scores — badges (4)
  {
    name: "get_top_scores",
    description: "Get the top user scores leaderboard.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max results to return (default 10, max 100)" },
      },
    },
  },
  {
    name: "get_my_badges",
    description: "Get badges earned by the authenticated user.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_user_score",
    description: "Get the score and trading stats for a specific user.",
    inputSchema: {
      type: "object" as const,
      properties: {
        userId: { type: "string", description: "User ID or wallet address" },
      },
      required: ["userId"],
    },
  },
  {
    name: "get_user_badges",
    description: "Get badges earned by a specific user.",
    inputSchema: {
      type: "object" as const,
      properties: {
        userId: { type: "string", description: "User ID or wallet address" },
      },
      required: ["userId"],
    },
  },

  // Portfolio — Polymarket-native (3)
  {
    name: "get_polymarket_portfolio",
    description: "Get the Polymarket-native portfolio view — positions, balances, and exposure across all markets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max positions to return (default 20, max 100)" },
        page: { type: "number", description: "Page number (default 1)" },
      },
    },
  },
  {
    name: "get_polymarket_earnings",
    description: "Get Polymarket-native earnings data — realized PnL, redeemed winnings, and fee rebates.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_polymarket_activity",
    description: "Get Polymarket-native activity feed — recent trades, redemptions, and position changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max activity entries to return (default 20, max 100)" },
        page: { type: "number", description: "Page number (default 1)" },
      },
    },
  },
  // ── Rewards & Rebates (closes #155) ─────────────────────────────────
  {
    name: "list_rewards_markets",
    description: "List all Polymarket markets that are eligible for liquidity rewards. Returns each market's condition ID, daily reward amount, and reward parameters.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_rewards_for_market",
    description: "Get reward details for a specific market by its Polymarket condition ID. Returns the reward rate, daily payout, and eligibility criteria for that market.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: { type: "string", description: "Polymarket condition ID of the market" },
      },
      required: ["conditionId"],
    },
  },
  {
    name: "get_user_rewards",
    description: "Get the authenticated user's accrued Polymarket liquidity rewards. Returns an array of reward entries with amounts and market details.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_user_rewards_total",
    description: "Get the authenticated user's total accumulated rewards with a breakdown by date. Useful for tracking reward earnings over time.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_user_rewards_percentages",
    description: "Get the authenticated user's reward allocation percentages. Shows the percentage breakdown of rewards across different markets or categories.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_user_rewards_per_market",
    description: "Get the authenticated user's rewards broken down by individual market. Shows how much each market has contributed to total rewards.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_user_rebates",
    description: "Get the authenticated user's Polymarket trading rebates. Returns rebate amounts earned from trading activity.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // ── POLA-790 Phase A: Cross-venue arbitrage ──────────────────────────
  {
    name: "get_cross_venue_opportunities",
    description: "Find cross-venue arbitrage opportunities between Polymarket and Kalshi. Returns matched markets where price discrepancies create potential arbitrage spreads.",
    inputSchema: {
      type: "object" as const,
      properties: {
        minSpread: { type: "number", description: "Minimum spread percentage to filter by (default: 3)" },
      },
    },
  },
  {
    name: "get_cross_venue_comparison",
    description: "Get a detailed price comparison between Polymarket and Kalshi for a specific matched market pair.",
    inputSchema: {
      type: "object" as const,
      properties: {
        matchId: { type: "string", description: "Cross-venue match ID" },
      },
      required: ["matchId"],
    },
  },
  {
    name: "list_arbitrage_matches",
    description: "List all cross-venue market matches between Polymarket and Kalshi. Optionally filter by verification status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        verified: { type: "string", enum: ["true", "false"], description: "Filter by verification status" },
        limit: { type: "number", description: "Max results (default 50, max 100)" },
        offset: { type: "number", description: "Offset for pagination (default 0)" },
      },
    },
  },
  {
    name: "get_arbitrage_matches_by_market",
    description: "Get all cross-venue matches associated with a specific Polymarket market.",
    inputSchema: {
      type: "object" as const,
      properties: {
        marketId: { type: "string", description: "Polymarket market ID" },
      },
      required: ["marketId"],
    },
  },
  {
    name: "create_arbitrage_match",
    description: "Manually create a cross-venue match linking a Polymarket market to a Kalshi event.",
    inputSchema: {
      type: "object" as const,
      properties: {
        polymarketId: { type: "string", description: "Polymarket condition ID" },
        kalshiId: { type: "string", description: "Kalshi event ticker or ID" },
      },
      required: ["polymarketId", "kalshiId"],
    },
  },
  {
    name: "verify_arbitrage_match",
    description: "Mark a cross-venue match as verified, confirming the Polymarket and Kalshi markets are equivalent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        matchId: { type: "string", description: "Cross-venue match ID to verify" },
      },
      required: ["matchId"],
    },
  },
  {
    name: "delete_arbitrage_match",
    description: "Delete a cross-venue market match.",
    inputSchema: {
      type: "object" as const,
      properties: {
        matchId: { type: "string", description: "Cross-venue match ID to delete" },
      },
      required: ["matchId"],
    },
  },
  {
    name: "sync_arbitrage_matches",
    description: "Trigger an automatic sync to discover and create new cross-venue market matches between Polymarket and Kalshi.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // ── POLA-790 Phase A: Whale alerts + smart money leaderboard ─────────
  {
    name: "get_smart_money_leaderboard",
    description: "Get the smart money leaderboard — top traders ranked by profitability, win rate, or volume over a time period.",
    inputSchema: {
      type: "object" as const,
      properties: {
        period: { type: "string", enum: ["24h", "7d", "30d", "all"], description: "Time period for ranking (default: all)" },
        limit: { type: "number", description: "Max results (default 20, max 100)" },
      },
    },
  },
  {
    name: "get_whale_alert_filter",
    description: "Get the authenticated user's whale alert filter configuration — minimum trade size, target markets, and wallet addresses to track.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "upsert_whale_alert_filter",
    description: "Create or update the whale alert filter. Configure minimum trade size, specific markets, wallet addresses, and trade sides to receive alerts for.",
    inputSchema: {
      type: "object" as const,
      properties: {
        minSize: { type: "string", description: "Minimum trade size as a decimal string (e.g. '1000')" },
        marketIds: { type: "array", items: { type: "string" }, description: "Market IDs to filter alerts (max 50)" },
        walletAddresses: { type: "array", items: { type: "string" }, description: "Wallet addresses to track (max 100)" },
        sides: { type: "array", items: { type: "string", enum: ["BUY", "SELL"] }, description: "Trade sides to filter (BUY, SELL, or both)" },
        active: { type: "boolean", description: "Enable or disable the alert filter" },
      },
    },
  },
  {
    name: "delete_whale_alert_filter",
    description: "Delete the authenticated user's whale alert filter configuration.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },

  // POLA-791 Phase B: Orders export, Portfolio export, Backtests quick
  {
    name: "export_orders_csv",
    description: "Export all your orders as a CSV file. Returns raw CSV text suitable for spreadsheet import.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "export_portfolio_csv",
    description: "Export your portfolio positions as a CSV file. Returns raw CSV text suitable for spreadsheet import.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "run_backtest_quick",
    description: "Run a quick backtest — faster iteration with reduced fidelity. Same parameters as run_backtest but returns results faster.",
    inputSchema: {
      type: "object" as const,
      properties: {
        strategyId: { type: "string", description: "Strategy UUID to backtest" },
        dateRangeStart: { type: "string", description: "Start date (ISO 8601: YYYY-MM-DD)" },
        dateRangeEnd: { type: "string", description: "End date (ISO 8601: YYYY-MM-DD)" },
        strategyBlocks: {
          type: "object",
          description: "Optional override: strategy block definitions (triggers, conditions, actions, safety, logicBlocks, calcBlocks)",
        },
        marketBindings: {
          type: "object",
          description: "Optional override: map of slot names to market UUIDs",
        },
      },
      required: ["strategyId"],
    },
  },
  // ── Profile management (POLA-792) ─────────────────────────────────
  {
    name: "update_my_profile",
    description: "Update the authenticated user's profile. Can change display name, bio, and avatar URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        displayName: { type: "string", description: "Display name (max 50 chars)" },
        bio: { type: "string", description: "Bio text (max 500 chars)" },
        avatarUrl: { type: "string", description: "Avatar image URL" },
      },
    },
  },
  {
    name: "change_password",
    description: "Change the authenticated user's password. Requires the current password for verification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        currentPassword: { type: "string", description: "Current password" },
        newPassword: { type: "string", description: "New password (8-128 chars)" },
      },
      required: ["currentPassword", "newPassword"],
    },
  },
  {
    name: "update_profile_notifications",
    description: "Update the authenticated user's notification preferences via the profile endpoint. Pass key-value pairs where keys are notification channel names and values are booleans.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: { type: "boolean" },
    },
  },
  {
    name: "get_profile",
    description: "Get a user's public profile by username. Returns display name, bio, follower/following counts, public strategy count, and whether the authenticated user follows them.",
    inputSchema: {
      type: "object" as const,
      properties: {
        username: { type: "string", description: "Username of the profile to view" },
      },
      required: ["username"],
    },
  },
  {
    name: "toggle_follow",
    description: "Follow or unfollow a user by username. Returns the new following state and updated follower count.",
    inputSchema: {
      type: "object" as const,
      properties: {
        username: { type: "string", description: "Username of the user to follow/unfollow" },
      },
      required: ["username"],
    },
  },
  // ── Settings (POLA-792) ───────────────────────────────────────────
  {
    name: "update_settings_profile",
    description: "Update profile settings via the settings endpoint. Can change display name, bio, avatar URL, and Twitter handle.",
    inputSchema: {
      type: "object" as const,
      properties: {
        displayName: { type: "string", description: "Display name (max 100 chars)" },
        bio: { type: "string", description: "Bio text (max 500 chars)" },
        avatarUrl: { type: "string", description: "Avatar image URL (HTTPS only)" },
        twitterHandle: { type: "string", description: "Twitter/X handle (max 50 chars)" },
      },
    },
  },
  {
    name: "get_settings_notifications",
    description: "Get the authenticated user's notification settings. Returns channel toggles (email, Telegram, Discord) and event-type toggles (order filled, strategy error, etc.).",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "update_settings_notifications",
    description: "Update the authenticated user's notification settings. Toggle notification channels and event types individually.",
    inputSchema: {
      type: "object" as const,
      properties: {
        emailEnabled: { type: "boolean", description: "Enable email notifications" },
        telegramEnabled: { type: "boolean", description: "Enable Telegram notifications" },
        discordEnabled: { type: "boolean", description: "Enable Discord notifications" },
        onOrderFilled: { type: "boolean", description: "Notify when an order is filled" },
        onStrategyError: { type: "boolean", description: "Notify on strategy errors" },
        onBacktestComplete: { type: "boolean", description: "Notify when a backtest completes" },
        onDailyLossLimit: { type: "boolean", description: "Notify on daily loss limit hit" },
        onMarketResolved: { type: "boolean", description: "Notify when a market resolves" },
        onSomeoneForked: { type: "boolean", description: "Notify when someone forks your strategy" },
        onSomeoneFollowed: { type: "boolean", description: "Notify when someone follows you" },
        onSomeoneLiked: { type: "boolean", description: "Notify when someone likes your strategy" },
        onSomeoneCommented: { type: "boolean", description: "Notify when someone comments" },
      },
    },
  },
  {
    name: "update_settings_password",
    description: "Update password via settings. Requires current password and a new password with at least one uppercase letter, one lowercase letter, and one digit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        currentPassword: { type: "string", description: "Current password (8-100 chars)" },
        newPassword: { type: "string", description: "New password (8-100 chars, must contain uppercase, lowercase, and digit)" },
      },
      required: ["currentPassword", "newPassword"],
    },
  },
  {
    name: "get_beta_usage",
    description: "Get the authenticated user's beta usage limits and current consumption. Shows strategy count, monthly volume, position size cap, backtest concurrency, and marketplace listing limits.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_gas_usage",
    description: "Get the authenticated user's daily gas usage. Returns today's usage, daily limit, and remaining gas allowance.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  // ── Support tickets (POLA-792) ────────────────────────────────────
  {
    name: "create_ticket",
    description: "Create a new support ticket. Provide a subject, message body, and optionally a category and priority level.",
    inputSchema: {
      type: "object" as const,
      properties: {
        subject: { type: "string", description: "Ticket subject (1-255 chars)" },
        category: { type: "string", enum: ["GENERAL", "BILLING", "TECHNICAL", "ACCOUNT", "BUG", "FEATURE_REQUEST"], description: "Ticket category (default: GENERAL)" },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"], description: "Ticket priority (default: MEDIUM)" },
        body: { type: "string", description: "Ticket message body (1-5000 chars)" },
      },
      required: ["subject", "body"],
    },
  },
  {
    name: "list_tickets",
    description: "List the authenticated user's support tickets with pagination. Returns ticket details and message history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        page: { type: "number", description: "Page number (default 1)" },
        limit: { type: "number", description: "Results per page (default 20, max 100)" },
      },
    },
  },
  {
    name: "get_ticket",
    description: "Get a specific support ticket by ID. Returns ticket details and full message thread.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Ticket UUID" },
      },
      required: ["id"],
    },
  },
  {
    name: "add_ticket_message",
    description: "Add a message to an existing support ticket. Use to reply or provide additional information.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "Ticket UUID" },
        body: { type: "string", description: "Message body (1-5000 chars)" },
      },
      required: ["id", "body"],
    },
  },
  // ── Notification & venue preferences (POLA-792) ───────────────────
  {
    name: "get_notification_preferences",
    description: "Get the authenticated user's per-event notification preferences and email digest setting.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "update_notification_preferences",
    description: "Update per-event notification preferences. Set in-app, email, and push toggles for each event type, and configure email digest frequency.",
    inputSchema: {
      type: "object" as const,
      properties: {
        preferences: {
          type: "array",
          items: {
            type: "object",
            properties: {
              event: { type: "string", description: "Event type identifier" },
              inApp: { type: "boolean", description: "Enable in-app notification" },
              email: { type: "boolean", description: "Enable email notification" },
              push: { type: "boolean", description: "Enable push notification" },
            },
            required: ["event"],
          },
          description: "Array of per-event notification settings",
        },
        emailDigest: { type: "string", description: "Email digest frequency (e.g. DAILY, WEEKLY)" },
      },
    },
  },
  {
    name: "get_venue_preferences",
    description: "Get the authenticated user's venue (exchange) preferences. Returns default venue, enabled venues list, and single-platform mode setting.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "update_venue_preferences",
    description: "Update venue (exchange) preferences. Set default trading venue, enable/disable venues, and toggle single-platform mode.",
    inputSchema: {
      type: "object" as const,
      properties: {
        defaultVenue: { type: "string", description: "Default trading venue identifier" },
        enabledVenues: { type: "array", items: { type: "string" }, description: "List of enabled venue identifiers (min 1)" },
        singlePlatformMode: { type: "boolean", description: "Restrict to single venue at a time" },
      },
    },
  },
];

// ─── Route mapping ─────────────────────────────────────────────────

interface RouteConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string | ((args: Record<string, unknown>) => string);
  schema?: z.ZodType<unknown>;
  query?: (args: Record<string, unknown>) => Record<string, string>;
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
}

export const CSV_EXPORT_PATHS: Record<string, string> = {
  export_orders_csv: "/api/v1/orders/export/csv",
  export_portfolio_csv: "/api/v1/portfolio/export/csv",
};

export const ROUTES: Record<string, RouteConfig> = {
  list_markets: { method: "GET", path: "/api/v1/markets", schema: listMarketsQuerySchema, query: (a) => pickDefined(a, ["search", "category", "sort", "closed", "limit", "page"]) },
  get_market: { method: "GET", path: (a) => `/api/v1/markets/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  list_strategies: { method: "GET", path: "/api/v1/strategies", schema: listStrategiesQuerySchema, query: (a) => pickDefined(a, ["status", "sort", "limit", "page"]) },
  get_strategy: { method: "GET", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  create_strategy: { method: "POST", path: "/api/v1/strategies", body: (a) => createStrategySchema.parse(a) },
  update_strategy: { method: "PATCH", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}`, body: (a) => { const { id: _id, ...rest } = updateStrategySchema.parse(a); return rest; } },
  create_strategy_from_description: { method: "POST", path: "/api/v1/strategies/from-description", body: (a) => createStrategyFromDescriptionSchema.parse(a) },
  start_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/start`, schema: startStrategySchema, body: (a) => { const parsed = startStrategySchema.parse(a); return { paperMode: parsed.mode === "paper", ...(parsed.deploymentMode && { deploymentMode: parsed.deploymentMode }) }; } },
  stop_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/stop`, schema: idSchema },
  get_strategy_templates: { method: "GET", path: "/api/v1/strategies/templates" },
  export_strategy: { method: "GET", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/export`, schema: idSchema },
  get_portfolio: { method: "GET", path: "/api/v1/portfolio" },
  get_orders: { method: "GET", path: "/api/v1/orders", schema: getOrdersQuerySchema, query: (a) => pickDefined(a, ["limit", "page", "status", "strategyId", "marketId", "from", "to"]) },
  get_score: { method: "GET", path: "/api/v1/scores/me" },
  get_whale_feed: { method: "GET", path: "/api/v1/whales/feed", schema: whaleFeedQuerySchema, query: (a) => pickDefined(a, ["minSize", "marketId", "page", "limit"]) },
  get_news_signals: { method: "GET", path: "/api/v1/news/signals", schema: newsSignalsQuerySchema, query: (a) => pickDefined(a, ["minConfidence", "marketId", "page", "limit"]) },
  get_accuracy: { method: "GET", path: "/api/v1/accuracy/me" },
  get_portfolio_review: { method: "GET", path: "/api/v1/ai/portfolio-review" },
  get_market_sentiment: { method: "GET", path: (a) => `/api/v1/news/sentiment/${encodeURIComponent(String(a.marketId))}`, schema: marketIdParamSchema },
  provide_liquidity: { method: "POST", path: "/api/v1/lp/provide", body: (a) => provideLiquiditySchema.parse(a) },
  list_alerts: { method: "GET", path: "/api/v1/alerts" },
  list_copy_configs: { method: "GET", path: "/api/v1/copy" },
  list_webhooks: { method: "GET", path: "/api/v1/webhooks" },
  create_webhook: { method: "POST", path: "/api/v1/webhooks", body: (a) => createWebhookSchema.parse(a) },
  delete_webhook: { method: "DELETE", path: (a) => `/api/v1/webhooks/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  test_webhook: { method: "POST", path: (a) => `/api/v1/webhooks/${encodeURIComponent(String(a.id))}/test`, schema: idSchema },
  list_watchlist: { method: "GET", path: "/api/v1/watchlist" },
  add_to_watchlist: { method: "POST", path: "/api/v1/watchlist", body: (a) => marketIdParamSchema.parse(a) },
  remove_from_watchlist: { method: "DELETE", path: (a) => `/api/v1/watchlist/${encodeURIComponent(String(a.marketId))}`, schema: marketIdParamSchema },
  get_watchlist_status: { method: "GET", path: (a) => `/api/v1/watchlist/${encodeURIComponent(String(a.marketId))}/status`, schema: marketIdParamSchema },
  ai_query: { method: "POST", path: "/api/v1/ai/query", body: (a) => aiQuerySchema.parse(a) },
  place_order: { method: "POST", path: "/api/v1/orders/place", body: (a) => placeOrderSchema.parse(a) },
  cancel_order: { method: "DELETE", path: (a) => `/api/v1/orders/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  get_portfolio_pnl: { method: "GET", path: "/api/v1/portfolio/pnl", schema: portfolioPnlQuerySchema, query: (a) => pickDefined(a, ["period", "strategyId"]) },
  list_backtests: { method: "GET", path: "/api/v1/backtests", schema: listBacktestsQuerySchema, query: (a) => pickDefined(a, ["limit", "page", "strategyId", "status"]) },
  get_backtest: { method: "GET", path: (a) => `/api/v1/backtests/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  run_backtest: { method: "POST", path: "/api/v1/backtests", body: (a) => runBacktestSchema.parse(a) },
  create_alert: { method: "POST", path: "/api/v1/alerts", body: (a) => createAlertSchema.parse(a) },
  delete_alert: { method: "DELETE", path: (a) => `/api/v1/alerts/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  close_position: { method: "POST", path: "/api/v1/orders/close-position", body: (a) => closePositionSchema.parse(a) },
  list_conditional_orders: { method: "GET", path: "/api/v1/orders/conditional", schema: listConditionalOrdersQuerySchema, query: (a) => pickDefined(a, ["status", "type", "limit", "page"]) },
  create_conditional_order: { method: "POST", path: "/api/v1/orders/conditional", body: (a) => createConditionalOrderSchema.parse(a) },
  get_conditional_order: { method: "GET", path: (a) => `/api/v1/orders/conditional/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  cancel_conditional_order: { method: "DELETE", path: (a) => `/api/v1/orders/conditional/${encodeURIComponent(String(a.id))}`, schema: idSchema },
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
  import_strategy: { method: "POST", path: "/api/v1/strategies/import", body: (a) => importStrategySchema.parse(a) },
  // Trading tools (closes #15)
  redeem_position: { method: "POST", path: "/api/v1/orders/redeem", body: (a) => redeemPositionSchema.parse(a) },
  split_position: { method: "POST", path: "/api/v1/orders/split", body: (a) => splitPositionSchema.parse(a) },
  merge_position: { method: "POST", path: "/api/v1/orders/merge", body: (a) => mergePositionSchema.parse(a) },
  get_marketplace_listing: { method: "GET", path: (a) => `/api/v1/marketplace/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  // Discovery & Ranking (closes #66)
  discover_strategies: { method: "GET", path: "/api/v1/discover", schema: discoverStrategiesSchema, query: (a) => pickDefined(a, ["sort", "category", "search", "limit", "page"]) },
  get_leaderboard: { method: "GET", path: "/api/v1/leaderboard", schema: leaderboardQuerySchema, query: (a) => pickDefined(a, ["period", "limit", "page"]) },
  // Paper Trading (closes #66)
  get_paper_summary: { method: "GET", path: "/api/v1/paper/summary" },
  reset_paper_account: { method: "POST", path: "/api/v1/paper/reset" },
  // Batch API (closes #66)
  batch_requests: { method: "POST", path: "/api/v1/batch", body: (a) => ({ items: batchRequestsSchema.parse(a).requests }) },
  // Extended Whale Intelligence (closes #66)
  get_top_whales: { method: "GET", path: "/api/v1/whales/top", schema: topWhalesQuerySchema, query: (a) => pickDefined(a, ["sortBy", "period", "limit"]) },
  get_whale_profile: { method: "GET", path: (a) => `/api/v1/whales/${encodeURIComponent(String(a.address))}`, schema: whaleAddressSchema },
  follow_whale: { method: "POST", path: (a) => `/api/v1/whales/${encodeURIComponent(String(a.address))}/follow`, schema: whaleAddressSchema },
  unfollow_whale: { method: "POST", path: (a) => `/api/v1/whales/${encodeURIComponent(String(a.address))}/unfollow`, schema: whaleAddressSchema },
  get_followed_whales: { method: "GET", path: "/api/v1/whales/following" },
  // Marketplace Seller CRUD (closes #66)
  create_marketplace_listing: { method: "POST", path: "/api/v1/marketplace", body: (a) => createMarketplaceListingSchema.parse(a) },
  update_marketplace_listing: { method: "PATCH", path: (a) => `/api/v1/marketplace/${encodeURIComponent(String(a.id))}`, body: (a) => { const { id: _id, ...rest } = updateMarketplaceListingSchema.parse(a); return rest; } },
  rate_marketplace_listing: { method: "POST", path: (a) => `/api/v1/marketplace/${encodeURIComponent(String(a.id))}/rate`, body: (a) => { const { id: _id, ...rest } = rateMarketplaceListingSchema.parse(a); return rest; } },
  get_my_listings: { method: "GET", path: "/api/v1/marketplace/my/listings" },
  get_my_purchases: { method: "GET", path: "/api/v1/marketplace/my/purchases" },
  // Copy Trading CRUD (closes #66)
  create_copy_config: { method: "POST", path: "/api/v1/copy", body: (a) => createCopyConfigSchema.parse(a) },
  get_copy_config: { method: "GET", path: (a) => `/api/v1/copy/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  update_copy_config: { method: "PATCH", path: (a) => `/api/v1/copy/${encodeURIComponent(String(a.id))}`, body: (a) => { const { id: _id, ...rest } = updateCopyConfigSchema.parse(a); return rest; } },
  pause_copy_config: { method: "POST", path: (a) => `/api/v1/copy/${encodeURIComponent(String(a.id))}/pause`, schema: idSchema },
  resume_copy_config: { method: "POST", path: (a) => `/api/v1/copy/${encodeURIComponent(String(a.id))}/resume`, schema: idSchema },
  delete_copy_config: { method: "DELETE", path: (a) => `/api/v1/copy/${encodeURIComponent(String(a.id))}`, schema: idSchema },
  get_copy_trades: { method: "GET", path: (a) => `/api/v1/copy/${encodeURIComponent(String(a.id))}/trades`, schema: idSchema },
  // Backtest Orders (closes #66)
  get_backtest_orders: { method: "GET", path: (a) => `/api/v1/backtests/${encodeURIComponent(String(a.id))}/orders`, schema: idSchema },
  // Price history (#126)
  get_price_history: { method: "GET", path: (a) => `/api/v1/markets/${encodeURIComponent(String(a.tokenId))}/price-history`, schema: getPriceHistorySchema, query: (a) => pickDefined(a, ["resolution", "from", "to", "limit"]) },
  // Strategy social (#126)
  like_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/like`, schema: idSchema },
  list_strategy_comments: { method: "GET", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/comments`, schema: idSchema, query: (a) => pickDefined(a, ["page", "limit"]) },  // #118
  add_strategy_comment: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/comments`, schema: addStrategyCommentSchema, body: (a) => { const parsed = addStrategyCommentSchema.parse(a); return { content: parsed.content }; } },
  delete_strategy_comment: { method: "DELETE", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/comments/${encodeURIComponent(String(a.commentId))}`, schema: deleteStrategyCommentSchema },
  list_strategy_children: { method: "GET", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/children`, schema: idSchema, query: (a) => pickDefined(a, ["page", "limit"]) },  // #118
  report_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/report`, schema: reportStrategySchema, body: (a) => { const parsed = reportStrategySchema.parse(a); return { reason: parsed.reason, ...(parsed.description !== undefined && { description: parsed.description }) }; } },
  // Strategy versioning (#126)
  list_strategy_versions: { method: "GET", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/versions`, schema: idSchema },
  rollback_strategy: { method: "POST", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/versions/${encodeURIComponent(String(a.versionId))}/rollback`, schema: rollbackStrategySchema },
  // Strategy event log (#126)
  get_strategy_event_log: { method: "GET", path: (a) => `/api/v1/strategies/${encodeURIComponent(String(a.id))}/event-log`, schema: idSchema, query: (a) => pickDefined(a, ["page", "limit"]) },  // #118
  // API key management (#126)
  list_api_keys: { method: "GET", path: "/api/v1/api-keys" },
  create_api_key: { method: "POST", path: "/api/v1/api-keys", body: (a) => createApiKeySchema.parse(a) },
  revoke_api_key: { method: "DELETE", path: (a) => `/api/v1/api-keys/${encodeURIComponent(String(a.id))}`, schema: idSchema },
// Risk Settings (closes #132)
  get_risk_settings: { method: "GET", path: "/api/v1/settings/risk" },
  update_risk_settings: { method: "PATCH", path: "/api/v1/settings/risk", schema: updateRiskSettingsSchema, body: (a) => updateRiskSettingsSchema.parse(a) },
  reset_circuit_breaker: { method: "POST", path: "/api/v1/settings/risk/reset" },
  // POLA-297: Missing platform endpoints
  search_markets: { method: "GET", path: "/api/v1/markets/search", schema: searchMarketsSchema, query: (a) => pickDefined(a, ["query", "limit", "page"]) },
  get_tick_size: { method: "GET", path: (a) => `/api/v1/markets/${encodeURIComponent(String(a.tokenId))}/tick-size`, schema: tokenIdParamSchema },
  get_spread: { method: "GET", path: (a) => `/api/v1/markets/${encodeURIComponent(String(a.tokenId))}/spread`, schema: tokenIdParamSchema },
  get_midpoint: { method: "GET", path: (a) => `/api/v1/markets/${encodeURIComponent(String(a.tokenId))}/midpoint`, schema: tokenIdParamSchema },
  get_clob_book: { method: "GET", path: (a) => `/api/v1/markets/${encodeURIComponent(String(a.tokenId))}/clob-book`, schema: tokenIdParamSchema },
  get_clob_prices_history: { method: "GET", path: (a) => `/api/v1/markets/${encodeURIComponent(String(a.tokenId))}/clob-prices-history`, schema: clobPricesHistorySchema, query: (a) => pickDefined(a, ["interval", "fidelity", "startTs", "endTs"]) },
  place_batch_orders: { method: "POST", path: "/api/v1/orders/batch", schema: placeBatchOrdersSchema, body: (a) => placeBatchOrdersSchema.parse(a) },
  cancel_orders_bulk: { method: "DELETE", path: "/api/v1/orders/bulk", schema: cancelOrdersBulkSchema, body: (a) => cancelOrdersBulkSchema.parse(a) },
  list_news: { method: "GET", path: "/api/v1/news", schema: listNewsSchema, query: (a) => pickDefined(a, ["limit", "page"]) },
  get_news_article: { method: "GET", path: (a) => `/api/v1/news/${encodeURIComponent(String(a.id))}`, schema: newsArticleIdSchema },
  get_top_scores: { method: "GET", path: "/api/v1/scores/top", schema: topScoresSchema, query: (a) => pickDefined(a, ["limit"]) },
  get_my_badges: { method: "GET", path: "/api/v1/scores/me/badges" },
  get_user_score: { method: "GET", path: (a) => `/api/v1/scores/${encodeURIComponent(String(a.userId))}`, schema: userIdParamSchema },
  get_user_badges: { method: "GET", path: (a) => `/api/v1/scores/${encodeURIComponent(String(a.userId))}/badges`, schema: userIdParamSchema },
  get_polymarket_portfolio: { method: "GET", path: "/api/v1/portfolio/polymarket/portfolio", schema: polymarketPortfolioSchema, query: (a) => pickDefined(a, ["limit", "page"]) },
  get_polymarket_earnings: { method: "GET", path: "/api/v1/portfolio/polymarket/earnings" },
  get_polymarket_activity: { method: "GET", path: "/api/v1/portfolio/polymarket/activity", schema: polymarketActivitySchema, query: (a) => pickDefined(a, ["limit", "page"]) },
  // Rewards & Rebates (closes #155)
  list_rewards_markets: { method: "GET", path: "/api/v1/rewards/markets" },
  get_rewards_for_market: { method: "GET", path: (a) => `/api/v1/rewards/markets/${encodeURIComponent(String(a.conditionId))}`, schema: conditionIdSchema },
  get_user_rewards: { method: "GET", path: "/api/v1/rewards/user" },
  get_user_rewards_total: { method: "GET", path: "/api/v1/rewards/user/total" },
  get_user_rewards_percentages: { method: "GET", path: "/api/v1/rewards/user/percentages" },
  get_user_rewards_per_market: { method: "GET", path: "/api/v1/rewards/user/markets" },
  get_user_rebates: { method: "GET", path: "/api/v1/rewards/rebates" },
  // POLA-790 Phase A: Cross-venue arbitrage
  get_cross_venue_opportunities: { method: "GET", path: "/api/v1/arbitrage/cross-venue", schema: crossVenueQuerySchema, query: (a) => pickDefined(a, ["minSpread"]) },
  get_cross_venue_comparison: { method: "GET", path: (a) => `/api/v1/arbitrage/cross-venue/${encodeURIComponent(String(a.matchId))}/comparison`, schema: matchIdParamSchema },
  list_arbitrage_matches: { method: "GET", path: "/api/v1/arbitrage/matches", schema: listMatchesQuerySchema, query: (a) => pickDefined(a, ["verified", "limit", "offset"]) },
  get_arbitrage_matches_by_market: { method: "GET", path: (a) => `/api/v1/arbitrage/matches/market/${encodeURIComponent(String(a.marketId))}`, schema: marketIdParamSchema },
  create_arbitrage_match: { method: "POST", path: "/api/v1/arbitrage/matches", body: (a) => createMatchSchema.parse(a) },
  verify_arbitrage_match: { method: "POST", path: (a) => `/api/v1/arbitrage/matches/${encodeURIComponent(String(a.matchId))}/verify`, schema: matchIdParamSchema },
  delete_arbitrage_match: { method: "DELETE", path: (a) => `/api/v1/arbitrage/matches/${encodeURIComponent(String(a.matchId))}`, schema: matchIdParamSchema },
  sync_arbitrage_matches: { method: "POST", path: "/api/v1/arbitrage/matches/sync" },
  // POLA-790 Phase A: Whale alerts + smart money leaderboard
  get_smart_money_leaderboard: { method: "GET", path: "/api/v1/whales/leaderboard", schema: smartMoneyLeaderboardSchema, query: (a) => pickDefined(a, ["period", "limit"]) },
  get_whale_alert_filter: { method: "GET", path: "/api/v1/whales/alerts/filter" },
  upsert_whale_alert_filter: { method: "PUT", path: "/api/v1/whales/alerts/filter", body: (a) => upsertWhaleAlertFilterSchema.parse(a) },
  delete_whale_alert_filter: { method: "DELETE", path: "/api/v1/whales/alerts/filter" },
  // POLA-791 Phase B: Quick backtest (CSV exports handled separately)
  run_backtest_quick: { method: "POST", path: "/api/v1/backtests/quick", schema: runBacktestSchema, body: (a) => runBacktestSchema.parse(a) },
  // get_strategy_events is handled separately (SSE polling, not a simple REST call)
  // export_orders_csv and export_portfolio_csv are handled separately (CSV response, not JSON)
  // Profile management (POLA-792)
  update_my_profile: { method: "PATCH", path: "/api/profile/me", body: (a) => updateMyProfileSchema.parse(a) },
  change_password: { method: "POST", path: "/api/profile/password", body: (a) => changePasswordSchema.parse(a) },
  update_profile_notifications: { method: "PATCH", path: "/api/profile/notifications", body: (a) => updateProfileNotificationsSchema.parse(a) },
  get_profile: { method: "GET", path: (a) => `/api/profile/${encodeURIComponent(String(a.username))}`, schema: usernameParamSchema },
  toggle_follow: { method: "POST", path: (a) => `/api/profile/${encodeURIComponent(String(a.username))}/follow`, schema: usernameParamSchema },

  // Settings (POLA-792)
  update_settings_profile: { method: "PATCH", path: "/api/settings/profile", body: (a) => updateSettingsProfileSchema.parse(a) },
  get_settings_notifications: { method: "GET", path: "/api/settings/notifications" },
  update_settings_notifications: { method: "PATCH", path: "/api/settings/notifications", body: (a) => updateSettingsNotificationsSchema.parse(a) },
  update_settings_password: { method: "PATCH", path: "/api/settings/password", body: (a) => updateSettingsPasswordSchema.parse(a) },
  get_beta_usage: { method: "GET", path: "/api/settings/beta-usage" },
  get_gas_usage: { method: "GET", path: "/api/settings/gas" },

  // Support tickets (POLA-792)
  create_ticket: { method: "POST", path: "/api/tickets", body: (a) => createTicketSchema.parse(a) },
  list_tickets: { method: "GET", path: "/api/tickets", schema: listTicketsSchema, query: (a) => pickDefined(a, ["page", "limit"]) },
  get_ticket: { method: "GET", path: (a) => `/api/tickets/${encodeURIComponent(String(a.id))}`, schema: ticketIdSchema },
  add_ticket_message: { method: "POST", path: (a) => `/api/tickets/${encodeURIComponent(String(a.id))}/messages`, body: (a) => { const { id: _id, ...rest } = addTicketMessageSchema.parse(a); return rest; } },

  // Notification & venue preferences (POLA-792)
  get_notification_preferences: { method: "GET", path: "/api/users/me/notification-preferences" },
  update_notification_preferences: { method: "PUT", path: "/api/users/me/notification-preferences", body: (a) => updateEventNotificationsSchema.parse(a) },
  get_venue_preferences: { method: "GET", path: "/api/users/me/venue-preferences" },
  update_venue_preferences: { method: "PATCH", path: "/api/users/me/venue-preferences", body: (a) => updateVenuePreferencesSchema.parse(a) },
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

  const apiUrl = POLYFORGE_API_URL;
  const apiKey = POLYFORGE_API_KEY!; // validated at startup — guaranteed non-empty

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

  // ── CSV export tools: return raw text, not JSON ──────────────────────
  const csvPaths = CSV_EXPORT_PATHS;
  if (csvPaths[name]) {
    await acquireRateLimitToken();
    try {
      const res = await fetch(new URL(csvPaths[name], apiUrl).toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        let errMsg: string;
        try {
          const body = await res.json() as { message?: unknown; error?: unknown };
          const field = body.message ?? body.error;
          errMsg = typeof field === "string" ? field.slice(0, 200) : `Request failed with status ${res.status}`;
        } catch {
          errMsg = `Request failed with status ${res.status}`;
        }
        return { content: [{ type: "text", text: `API error: ${errMsg}` }], isError: true };
      }
      const csv = await res.text();
      return { content: [{ type: "text", text: csv }] };
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
    // Extract only a structured message field to prevent raw API body disclosure (#109)
    let errMsg: string;
    try {
      const body = await res.json() as { message?: unknown; error?: unknown };
      const field = body.message ?? body.error;
      errMsg = typeof field === "string" ? field.slice(0, 200) : `Request failed with status ${res.status}`;
    } catch {
      errMsg = `Request failed with status ${res.status}`;
    }
    throw new Error(errMsg);
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

      if (buf.length > MAX_SSE_BUFFER_SIZE) {
        controller.abort();
        throw new Error("SSE event exceeded maximum buffer size (1 MB)");
      }

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
      // Extract only a structured message field to prevent raw API body disclosure (#109)
      let errMsg: string;
      try {
        const body = await res.json() as { message?: unknown; error?: unknown };
        const field = body.message ?? body.error;
        errMsg = typeof field === "string" ? field.slice(0, 200) : `Request failed with status ${res.status}`;
      } catch {
        errMsg = `Request failed with status ${res.status}`;
      }
      throw new Error(errMsg);
    }

    if (res.status === 204) {
      return { success: true };
    }
    return res.json();
  }

  throw new Error("Rate limited: max retries exceeded");
}

// ─── Startup validation ─────────────────────────────────────────

if (!POLYFORGE_API_KEY) {
  process.stderr.write(
    "FATAL: POLYFORGE_API_KEY environment variable is required. " +
    "Generate an API key in Polyforge Settings > API Keys.\n"
  );
  process.exit(1);
}

const parsedApiUrl = new URL(POLYFORGE_API_URL);
if (
  parsedApiUrl.protocol !== "https:" &&
  parsedApiUrl.hostname !== "localhost" &&
  parsedApiUrl.hostname !== "127.0.0.1"
) {
  process.stderr.write(
    "FATAL: POLYFORGE_API_URL must use HTTPS for non-localhost hosts.\n"
  );
  process.exit(1);
}

if (!process.env.POLYFORGE_API_URL) {
  process.stderr.write(
    "[polyforge-mcp] WARNING: POLYFORGE_API_URL is not set — falling back to https://localhost:3002. " +
    "Production deployments MUST set POLYFORGE_API_URL to the real API endpoint (e.g. https://api.polyforge.app). " +
    "Using localhost with HTTPS requires a trusted certificate; do NOT set NODE_TLS_REJECT_UNAUTHORIZED=0 as a workaround.\n"
  );
}

// ─── Start ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport);
