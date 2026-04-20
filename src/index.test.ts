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
  let ROUTES: Record<string, { body?: (a: Record<string, unknown>) => Record<string, unknown> }>;

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
});
