import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  GAME_ACTIONS,
  GameAction,
  GameSnapshot,
  GameState,
  advanceGame,
  applyAction,
  chooseDemoAgentAction,
  createGame,
  listAvailableActions,
  snapshotGame
} from "../src/game.js";

const STATE_PATH = process.env.PAPERCLIP_STATE_PATH ?? join(process.cwd(), ".paperclip-agent-state.json");
const BRIDGE_PORT = Number(process.env.PAPERCLIP_BRIDGE_PORT ?? 8787);

let game = loadGame();

const mcpServer = new McpServer({
  name: "paperclip-battler",
  version: "0.1.0"
});

mcpServer.registerResource(
  "agent-state",
  "paperclip://agent/state",
  {
    title: "Agent Paperclip State",
    description: "Current state for the MCP-controlled paperclip game.",
    mimeType: "application/json"
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(tickAndSnapshot(), null, 2)
      }
    ]
  })
);

mcpServer.registerTool(
  "get_agent_state",
  {
    title: "Get Agent State",
    description: "Read the current game state, derived metrics, and valid actions for the agent side.",
    inputSchema: {}
  },
  async () => textJson(tickAndSnapshot())
);

mcpServer.registerTool(
  "list_agent_actions",
  {
    title: "List Agent Actions",
    description: "List every action the agent can attempt and whether it is currently available.",
    inputSchema: {}
  },
  async () => textJson(listAvailableActions(tickAndSnapshot().state))
);

mcpServer.registerTool(
  "take_agent_action",
  {
    title: "Take Agent Action",
    description: "Apply one action to the agent game.",
    inputSchema: {
      action: z.enum(GAME_ACTIONS).describe("Action id to apply.")
    }
  },
  async ({ action }) => textJson(runAction(action))
);

mcpServer.registerTool(
  "advance_agent_game",
  {
    title: "Advance Agent Game",
    description: "Advance the agent game clock without taking a purchase or pricing action.",
    inputSchema: {
      seconds: z.number().min(0.1).max(600).default(1).describe("Seconds to simulate.")
    }
  },
  async ({ seconds }) => {
    advanceBySeconds(seconds);
    return textJson(tickAndSnapshot());
  }
);

mcpServer.registerTool(
  "suggest_agent_action",
  {
    title: "Suggest Agent Action",
    description: "Return a simple built-in heuristic action. External agents can ignore this.",
    inputSchema: {}
  },
  async () => {
    const snapshot = tickAndSnapshot();
    const action = chooseDemoAgentAction(snapshot.state);
    return textJson({
      action,
      label: action,
      snapshot
    });
  }
);

mcpServer.registerTool(
  "reset_agent_game",
  {
    title: "Reset Agent Game",
    description: "Reset only the MCP-controlled agent side.",
    inputSchema: {}
  },
  async () => {
    game = createGame("Agent", "agent");
    saveGame(game);
    return textJson(tickAndSnapshot());
  }
);

startBridge();

const transport = new StdioServerTransport();
await mcpServer.connect(transport);

function runAction(action: GameAction) {
  const outcome = applyAction(game, action, Date.now());
  game = outcome.state;
  saveGame(game);
  return {
    ok: outcome.ok,
    message: outcome.message,
    snapshot: tickAndSnapshot()
  };
}

function tickAndSnapshot(): GameSnapshot {
  game = advanceGame(game, Date.now());
  saveGame(game);
  return snapshotGame(game, game.lastTickAt);
}

function advanceBySeconds(seconds: number) {
  let remaining = Math.max(0, seconds);
  while (remaining > 0) {
    const step = Math.min(60, remaining);
    game = advanceGame(game, game.lastTickAt + step * 1_000);
    remaining -= step;
  }
  saveGame(game);
}

function startBridge() {
  if (!Number.isFinite(BRIDGE_PORT) || BRIDGE_PORT <= 0) {
    return;
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "content-type");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, name: "paperclip-battler", statePath: STATE_PATH });
        return;
      }

      if (request.method === "GET" && url.pathname === "/state") {
        sendJson(response, 200, tickAndSnapshot());
        return;
      }

      if (request.method === "GET" && url.pathname === "/actions") {
        sendJson(response, 200, listAvailableActions(tickAndSnapshot().state));
        return;
      }

      if (request.method === "POST" && url.pathname === "/action") {
        const body = await readJsonBody<{ action?: string }>(request);
        if (!isGameAction(body.action)) {
          sendJson(response, 400, { ok: false, message: "Unknown action." });
          return;
        }
        sendJson(response, 200, runAction(body.action));
        return;
      }

      if (request.method === "POST" && url.pathname === "/advance") {
        const body = await readJsonBody<{ seconds?: number }>(request);
        advanceBySeconds(clamp(Number(body.seconds ?? 1), 0.1, 600));
        sendJson(response, 200, tickAndSnapshot());
        return;
      }

      if (request.method === "POST" && url.pathname === "/reset") {
        game = createGame("Agent", "agent");
        saveGame(game);
        sendJson(response, 200, { ok: true, snapshot: tickAndSnapshot() });
        return;
      }

      sendJson(response, 404, { ok: false, message: "Not found." });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        message: error instanceof Error ? error.message : "Bridge error."
      });
    }
  });

  server.on("error", (error) => {
    console.error(`Paperclip Battler bridge unavailable on port ${BRIDGE_PORT}:`, error);
  });

  server.listen(BRIDGE_PORT, "127.0.0.1", () => {
    console.error(`Paperclip Battler bridge listening on http://127.0.0.1:${BRIDGE_PORT}`);
  });
}

function loadGame(): GameState {
  if (!existsSync(STATE_PATH)) {
    return createGame("Agent", "agent");
  }

  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<GameState>;
    const fresh = createGame("Agent", "agent");
    return {
      ...fresh,
      ...parsed,
      upgrades: Array.isArray(parsed.upgrades) ? parsed.upgrades : fresh.upgrades,
      log: Array.isArray(parsed.log) ? parsed.log : fresh.log,
      lastTickAt: typeof parsed.lastTickAt === "number" ? parsed.lastTickAt : Date.now()
    };
  } catch {
    return createGame("Agent", "agent");
  }
}

function saveGame(state: GameState) {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function textJson(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(body) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function isGameAction(value: unknown): value is GameAction {
  return typeof value === "string" && GAME_ACTIONS.includes(value as GameAction);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
