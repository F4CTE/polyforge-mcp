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

  beforeAll(async () => {
    const mod = await import("./index.js");
    ROUTES = mod.ROUTES;
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
});
