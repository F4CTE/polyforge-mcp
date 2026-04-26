import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler() {}
    connect() {}
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolRequestSchema: Symbol("CallToolRequestSchema"),
  ListToolsRequestSchema: Symbol("ListToolsRequestSchema"),
}));

describe("ROUTES", () => {
  let ROUTES: Record<string, {
    method: string;
    path: string | ((a: Record<string, unknown>) => string);
    schema?: { parse: (a: unknown) => unknown };
    query?: (a: Record<string, unknown>) => Record<string, string>;
    body?: (a: Record<string, unknown>) => Record<string, unknown>;
  }>;
  let CSV_EXPORT_PATHS: Record<string, string>;

  beforeAll(async () => {
    const mod = await import("./index.js");
    ROUTES = mod.ROUTES;
    CSV_EXPORT_PATHS = mod.CSV_EXPORT_PATHS;
  });

  it("batch_requests body sends 'items' key (not 'requests') to match platform API", () => {
    const body = ROUTES.batch_requests.body!;
    const input = {
      requests: [
        { id: "req-1", method: "GET", path: "/api/v1/markets" },
        { id: "req-2", method: "GET", path: "/api/v1/portfolio" },
      ],
    };

    const result = body(input);

    expect(result).toHaveProperty("items");
    expect(result).not.toHaveProperty("requests");
    expect(result.items).toEqual(input.requests);
  });

  // ── POLA-1021: #200 — batch request body size limit ────────────────

  it("batch_requests rejects body exceeding 64 KB", () => {
    const body = ROUTES.batch_requests.body!;
    expect(() => {
      body({
        requests: [
          {
            id: "test",
            method: "POST",
            path: "/api/v1/markets",
            body: Object.fromEntries(
              Array.from({ length: 50 }, (_, i) => [`key${i}`, "x".repeat(2000)])
            ),
          },
        ],
      });
    }).toThrow(/64 KB/);
  });

  // ── POLA-790: Cross-venue arbitrage routes ──────────────────────────

  const POLA_790_ARBITRAGE_TOOLS = [
    "get_cross_venue_opportunities",
    "get_cross_venue_comparison",
    "list_arbitrage_matches",
    "get_arbitrage_matches_by_market",
    "create_arbitrage_match",
    "verify_arbitrage_match",
    "delete_arbitrage_match",
    "sync_arbitrage_matches",
  ] as const;

  const POLA_790_WHALE_TOOLS = [
    "get_smart_money_leaderboard",
    "get_whale_alert_filter",
    "upsert_whale_alert_filter",
    "delete_whale_alert_filter",
  ] as const;

  it.each([...POLA_790_ARBITRAGE_TOOLS, ...POLA_790_WHALE_TOOLS])(
    "%s is registered in ROUTES",
    (name) => {
      expect(ROUTES[name]).toBeDefined();
      expect(ROUTES[name].method).toBeTruthy();
    },
  );

  it("get_cross_venue_opportunities is GET with query params", () => {
    const route = ROUTES.get_cross_venue_opportunities;
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/api/v1/arbitrage/cross-venue");
    const q = route.query!({ minSpread: 5 });
    expect(q).toEqual({ minSpread: "5" });
  });

  it("get_cross_venue_comparison builds path with matchId", () => {
    const route = ROUTES.get_cross_venue_comparison;
    expect(route.method).toBe("GET");
    const path = (route.path as (a: Record<string, unknown>) => string)({ matchId: "abc-123" });
    expect(path).toBe("/api/v1/arbitrage/cross-venue/abc-123/comparison");
  });

  it("list_arbitrage_matches passes verified/limit/offset as query", () => {
    const route = ROUTES.list_arbitrage_matches;
    expect(route.method).toBe("GET");
    const q = route.query!({ verified: "true", limit: 10, offset: 5 });
    expect(q).toEqual({ verified: "true", limit: "10", offset: "5" });
  });

  it("get_arbitrage_matches_by_market builds path with marketId", () => {
    const route = ROUTES.get_arbitrage_matches_by_market;
    const path = (route.path as (a: Record<string, unknown>) => string)({ marketId: "market-456" });
    expect(path).toBe("/api/v1/arbitrage/matches/market/market-456");
  });

  it("create_arbitrage_match validates and passes body", () => {
    const route = ROUTES.create_arbitrage_match;
    expect(route.method).toBe("POST");
    const body = route.body!({ polymarketId: "pm-1", kalshiId: "kal-1" });
    expect(body).toEqual({ polymarketId: "pm-1", kalshiId: "kal-1" });
  });

  it("create_arbitrage_match rejects empty polymarketId", () => {
    const route = ROUTES.create_arbitrage_match;
    expect(() => route.body!({ polymarketId: "", kalshiId: "kal-1" })).toThrow();
  });

  it("verify_arbitrage_match builds path with matchId", () => {
    const route = ROUTES.verify_arbitrage_match;
    expect(route.method).toBe("POST");
    const path = (route.path as (a: Record<string, unknown>) => string)({ matchId: "m-789" });
    expect(path).toBe("/api/v1/arbitrage/matches/m-789/verify");
  });

  it("delete_arbitrage_match builds path with matchId", () => {
    const route = ROUTES.delete_arbitrage_match;
    expect(route.method).toBe("DELETE");
    const path = (route.path as (a: Record<string, unknown>) => string)({ matchId: "m-del" });
    expect(path).toBe("/api/v1/arbitrage/matches/m-del");
  });

  it("sync_arbitrage_matches is POST with no body", () => {
    const route = ROUTES.sync_arbitrage_matches;
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/api/v1/arbitrage/matches/sync");
    expect(route.body).toBeUndefined();
  });

  // ── POLA-790: Whale alerts + leaderboard routes ─────────────────────

  it("get_smart_money_leaderboard passes period and limit as query", () => {
    const route = ROUTES.get_smart_money_leaderboard;
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/api/v1/whales/leaderboard");
    const q = route.query!({ period: "7d", limit: 50 });
    expect(q).toEqual({ period: "7d", limit: "50" });
  });

  it("get_whale_alert_filter is GET with no params", () => {
    const route = ROUTES.get_whale_alert_filter;
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/api/v1/whales/alerts/filter");
  });

  it("upsert_whale_alert_filter uses PUT and validates body", () => {
    const route = ROUTES.upsert_whale_alert_filter;
    expect(route.method).toBe("PUT");
    const body = route.body!({
      minSize: "1000",
      sides: ["BUY"],
      active: true,
    });
    expect(body).toEqual({
      minSize: "1000",
      sides: ["BUY"],
      active: true,
    });
  });

  it("upsert_whale_alert_filter rejects invalid minSize", () => {
    const route = ROUTES.upsert_whale_alert_filter;
    expect(() => route.body!({ minSize: "not-a-number" })).toThrow();
  });

  it("upsert_whale_alert_filter rejects invalid side", () => {
    const route = ROUTES.upsert_whale_alert_filter;
    expect(() => route.body!({ sides: ["HOLD"] })).toThrow();
  });

  it("delete_whale_alert_filter is DELETE with static path", () => {
    const route = ROUTES.delete_whale_alert_filter;
    expect(route.method).toBe("DELETE");
    expect(route.path).toBe("/api/v1/whales/alerts/filter");
  });

  // ── POLA-791 Phase B: Orders, Portfolio, News, Backtests ────────────

  const POLA_791_PHASE_B_ROUTE_TOOLS = [
    "place_batch_orders",
    "cancel_orders_bulk",
    "list_news",
    "get_news_article",
    "get_polymarket_portfolio",
    "get_polymarket_earnings",
    "get_polymarket_activity",
    "run_backtest_quick",
  ] as const;

  it.each(POLA_791_PHASE_B_ROUTE_TOOLS)(
    "%s is registered in ROUTES",
    (name) => {
      expect(ROUTES[name]).toBeDefined();
      expect(ROUTES[name].method).toBeTruthy();
    },
  );

  it("run_backtest_quick is POST to /api/v1/backtests/quick", () => {
    const route = ROUTES.run_backtest_quick;
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/api/v1/backtests/quick");
  });

  it("run_backtest_quick validates and passes body with strategyId", () => {
    const route = ROUTES.run_backtest_quick;
    const body = route.body!({
      strategyId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      dateRangeStart: "2025-01-01",
      dateRangeEnd: "2025-06-01",
    });
    expect(body).toMatchObject({
      strategyId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      dateRangeStart: "2025-01-01",
      dateRangeEnd: "2025-06-01",
    });
  });

  it("run_backtest_quick rejects non-UUID strategyId", () => {
    const route = ROUTES.run_backtest_quick;
    expect(() => route.body!({ strategyId: "not-a-uuid" })).toThrow();
  });

  it("run_backtest_quick rejects invalid date format", () => {
    const route = ROUTES.run_backtest_quick;
    expect(() => route.body!({
      strategyId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      dateRangeStart: "January 1st",
    })).toThrow();
  });

  it("place_batch_orders is POST to /api/v1/orders/batch", () => {
    const route = ROUTES.place_batch_orders;
    expect(route.method).toBe("POST");
    expect(route.path).toBe("/api/v1/orders/batch");
  });

  it("cancel_orders_bulk is DELETE to /api/v1/orders/bulk", () => {
    const route = ROUTES.cancel_orders_bulk;
    expect(route.method).toBe("DELETE");
    expect(route.path).toBe("/api/v1/orders/bulk");
  });

  it("list_news passes limit and page as query", () => {
    const route = ROUTES.list_news;
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/api/v1/news");
    const q = route.query!({ limit: 50, page: 2 });
    expect(q).toEqual({ limit: "50", page: "2" });
  });

  it("get_news_article builds path with article id", () => {
    const route = ROUTES.get_news_article;
    expect(route.method).toBe("GET");
    const path = (route.path as (a: Record<string, unknown>) => string)({ id: "article-123" });
    expect(path).toBe("/api/v1/news/article-123");
  });

  it("get_polymarket_portfolio passes limit and page as query", () => {
    const route = ROUTES.get_polymarket_portfolio;
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/api/v1/portfolio/polymarket/portfolio");
    const q = route.query!({ limit: 20, page: 1 });
    expect(q).toEqual({ limit: "20", page: "1" });
  });

  it("get_polymarket_earnings is GET with no query", () => {
    const route = ROUTES.get_polymarket_earnings;
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/api/v1/portfolio/polymarket/earnings");
  });

  it("get_polymarket_activity passes limit and page as query", () => {
    const route = ROUTES.get_polymarket_activity;
    expect(route.method).toBe("GET");
    expect(route.path).toBe("/api/v1/portfolio/polymarket/activity");
    const q = route.query!({ limit: 30, page: 3 });
    expect(q).toEqual({ limit: "30", page: "3" });
  });

  // ── POLA-791: CSV export paths ─────────────────────────────────────

  it("CSV_EXPORT_PATHS maps export_orders_csv", () => {
    expect(CSV_EXPORT_PATHS.export_orders_csv).toBe("/api/v1/orders/export/csv");
  });

  it("CSV_EXPORT_PATHS maps export_portfolio_csv", () => {
    expect(CSV_EXPORT_PATHS.export_portfolio_csv).toBe("/api/v1/portfolio/export/csv");
  });

  // ── POLA-792: Profile management routes ─────────────────────────

  it("update_my_profile passes validated body fields", () => {
    const body = ROUTES.update_my_profile.body!;
    const result = body({ displayName: "Test", bio: "Hello" });
    expect(result).toEqual({ displayName: "Test", bio: "Hello" });
  });

  it("change_password passes currentPassword and newPassword", () => {
    const body = ROUTES.change_password.body!;
    const result = body({ currentPassword: "old123", newPassword: "newPass99" });
    expect(result).toEqual({ currentPassword: "old123", newPassword: "newPass99" });
  });

  it("update_profile_notifications passes boolean record", () => {
    const body = ROUTES.update_profile_notifications.body!;
    const result = body({ email: true, sms: false });
    expect(result).toEqual({ email: true, sms: false });
  });

  // ── POLA-1021: #199 — notification preferences key count cap ───────

  it("update_profile_notifications rejects more than 50 keys", () => {
    const body = ROUTES.update_profile_notifications.body!;
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`pref${i}`, true])
    );
    expect(() => body(tooManyKeys)).toThrow();
  });

  it("update_profile_notifications accepts exactly 50 keys", () => {
    const body = ROUTES.update_profile_notifications.body!;
    const fiftyKeys = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`pref${i}`, true])
    );
    expect(body(fiftyKeys)).toEqual(fiftyKeys);
  });

  it("get_profile builds path with encoded username", () => {
    const path = ROUTES.get_profile.path as (a: Record<string, unknown>) => string;
    expect(path({ username: "john doe" })).toBe("/api/v1/profile/john%20doe");
  });

  it("toggle_follow builds path with encoded username", () => {
    const path = ROUTES.toggle_follow.path as (a: Record<string, unknown>) => string;
    expect(path({ username: "alice" })).toBe("/api/v1/profile/alice/follow");
  });

  // ── POLA-792: Settings routes ─────────────────────────────────────

  it("update_settings_profile passes validated body", () => {
    const body = ROUTES.update_settings_profile.body!;
    const result = body({ displayName: "Dev", twitterHandle: "@dev" });
    expect(result).toEqual({ displayName: "Dev", twitterHandle: "@dev" });
  });

  it("update_settings_notifications passes notification toggles", () => {
    const body = ROUTES.update_settings_notifications.body!;
    const result = body({ emailEnabled: true, onOrderFilled: false });
    expect(result).toEqual({ emailEnabled: true, onOrderFilled: false });
  });

  it("update_settings_password rejects weak passwords", () => {
    const body = ROUTES.update_settings_password.body!;
    expect(() => body({ currentPassword: "oldpass1", newPassword: "nouppercase1" })).toThrow();
  });

  it("update_settings_password accepts valid passwords", () => {
    const body = ROUTES.update_settings_password.body!;
    const result = body({ currentPassword: "OldPass1!", newPassword: "NewPass1!" });
    expect(result).toEqual({ currentPassword: "OldPass1!", newPassword: "NewPass1!" });
  });

  it("update_risk_settings passes validated risk config", () => {
    const body = ROUTES.update_risk_settings.body!;
    const result = body({ drawdownEnabled: true, drawdownThresholdPct: 0.10 });
    expect(result).toEqual({ drawdownEnabled: true, drawdownThresholdPct: 0.10 });
  });

  it("get_settings_notifications has no body transformer", () => {
    expect(ROUTES.get_settings_notifications.body).toBeUndefined();
  });

  it("get_beta_usage is a GET with no body", () => {
    expect(ROUTES.get_beta_usage.method).toBe("GET");
    expect(ROUTES.get_beta_usage.body).toBeUndefined();
  });

  it("get_gas_usage is a GET with no body", () => {
    expect(ROUTES.get_gas_usage.method).toBe("GET");
    expect(ROUTES.get_gas_usage.body).toBeUndefined();
  });

  it("reset_circuit_breaker is a POST", () => {
    expect(ROUTES.reset_circuit_breaker.method).toBe("POST");
  });

  // ── POLA-792: Support ticket routes ───────────────────────────────

  it("create_ticket passes validated ticket body", () => {
    const body = ROUTES.create_ticket.body!;
    const result = body({ subject: "Help", body: "Need assistance", category: "TECHNICAL" });
    expect(result).toEqual({ subject: "Help", body: "Need assistance", category: "TECHNICAL" });
  });

  it("create_ticket rejects invalid category", () => {
    const body = ROUTES.create_ticket.body!;
    expect(() => body({ subject: "Help", body: "Text", category: "INVALID" })).toThrow();
  });

  it("list_tickets uses query params for pagination", () => {
    const query = ROUTES.list_tickets.query!;
    const result = query({ page: 2, limit: 10 });
    expect(result).toEqual({ page: "2", limit: "10" });
  });

  it("get_ticket builds path with encoded UUID", () => {
    const path = ROUTES.get_ticket.path as (a: Record<string, unknown>) => string;
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(path({ id: uuid })).toBe(`/api/v1/tickets/${uuid}`);
  });

  it("add_ticket_message strips id from body", () => {
    const body = ROUTES.add_ticket_message.body!;
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = body({ id: uuid, body: "Reply text" });
    expect(result).toEqual({ body: "Reply text" });
    expect(result).not.toHaveProperty("id");
  });

  // ── POLA-792: Notification & venue preference routes ──────────────

  it("update_notification_preferences passes preferences array", () => {
    const body = ROUTES.update_notification_preferences.body!;
    const result = body({
      preferences: [{ event: "order_filled", inApp: true, email: false }],
      emailDigest: "DAILY",
    });
    expect(result).toEqual({
      preferences: [{ event: "order_filled", inApp: true, email: false }],
      emailDigest: "DAILY",
    });
  });

  it("update_venue_preferences passes venue config", () => {
    const body = ROUTES.update_venue_preferences.body!;
    const result = body({ defaultVenue: "polymarket", enabledVenues: ["polymarket", "kalshi"], singlePlatformMode: false });
    expect(result).toEqual({ defaultVenue: "polymarket", enabledVenues: ["polymarket", "kalshi"], singlePlatformMode: false });
  });

  it("get_venue_preferences is a GET with no body", () => {
    expect(ROUTES.get_venue_preferences.method).toBe("GET");
    expect(ROUTES.get_venue_preferences.body).toBeUndefined();
  });

  it("get_notification_preferences is a GET with no body", () => {
    expect(ROUTES.get_notification_preferences.method).toBe("GET");
    expect(ROUTES.get_notification_preferences.body).toBeUndefined();
  });

  // ── Regression: every route must use /api/v1/ or /auth/v1/ prefix ──

  it("all ROUTES paths start with /api/v1/ or /auth/v1/", () => {
    const ALLOWED_PREFIXES = ["/api/v1/", "/auth/v1/"];
    const violations: string[] = [];

    for (const [name, route] of Object.entries(ROUTES)) {
      let resolvedPath: string;
      if (typeof route.path === "function") {
        resolvedPath = route.path({ username: "test", id: "test", matchId: "test", slug: "test", marketId: "test" });
      } else {
        resolvedPath = route.path;
      }
      if (!ALLOWED_PREFIXES.some((prefix) => resolvedPath.startsWith(prefix))) {
        violations.push(`${name}: ${resolvedPath}`);
      }
    }

    expect(violations).toEqual([]);
  });

  // ── POLA-792: All new tools exist in ROUTES ───────────────────────

  it.each([
    "update_my_profile", "change_password", "update_profile_notifications",
    "get_profile", "toggle_follow",
    "update_settings_profile", "get_settings_notifications", "update_settings_notifications",
    "update_settings_password", "get_beta_usage", "get_gas_usage",
    "get_risk_settings", "update_risk_settings", "reset_circuit_breaker",
    "create_ticket", "list_tickets", "get_ticket", "add_ticket_message",
    "get_notification_preferences", "update_notification_preferences",
    "get_venue_preferences", "update_venue_preferences",
  ])("ROUTES has entry for %s", (name) => {
    expect(ROUTES[name]).toBeDefined();
    expect(ROUTES[name].method).toBeDefined();
    expect(ROUTES[name].path).toBeDefined();
  });

});