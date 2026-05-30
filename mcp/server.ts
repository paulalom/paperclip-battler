import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const ORIGINAL_BASE = "https://www.decisionproblem.com/paperclips/";
const ORIGINAL_ENTRY = "index2.html";
const BRIDGE_PORT = Number(process.env.PAPERCLIP_BRIDGE_PORT ?? 8787);
const COMMAND_TIMEOUT_MS = 5_000;
const REPORT_STALE_MS = 8_000;
const CLAIM_TTL_MS = Number(process.env.PAPERCLIP_PLAYER_CLAIM_TTL_MS ?? 10 * 60 * 1000);
const DEFAULT_ROOM_ID = "local";
const ROOM_ID_LENGTH = 6;
const DEFAULT_LOBBY_TTL_MS = Number(process.env.PAPERCLIP_DEFAULT_LOBBY_TTL_MS ?? 30 * 60 * 1000);
const COMPLETED_ROOM_TTL_MS = Number(process.env.PAPERCLIP_COMPLETED_ROOM_TTL_MS ?? 5 * 60 * 1000);
const IDLE_ROOM_TTL_MS = Number(process.env.PAPERCLIP_IDLE_ROOM_TTL_MS ?? 60 * 60 * 1000);
const IDLE_ROOM_WARNING_MS = Number(process.env.PAPERCLIP_IDLE_ROOM_WARNING_MS ?? 5 * 60 * 1000);
const MAX_ROOM_AGE_MS = Number(process.env.PAPERCLIP_MAX_ROOM_AGE_MS ?? 24 * 60 * 60 * 1000);
const MAX_ROOM_AGE_WARNING_MS = Number(process.env.PAPERCLIP_MAX_ROOM_AGE_WARNING_MS ?? 60 * 60 * 1000);
const ROOM_CLEANUP_INTERVAL_MS = Number(process.env.PAPERCLIP_ROOM_CLEANUP_INTERVAL_MS ?? 5_000);
const CLOSED_ROOM_TOMBSTONE_TTL_MS = Number(process.env.PAPERCLIP_CLOSED_ROOM_TOMBSTONE_TTL_MS ?? 60 * 60 * 1000);
const ROOM_PARTICIPANT_TTL_MS = Number(process.env.PAPERCLIP_ROOM_PARTICIPANT_TTL_MS ?? 15_000);
const SPECTATOR_SAVE_SYNC_INTERVAL_MS = 5_000;
const BRIDGE_HEURISTIC_DECISION_TICK_MS = Number(process.env.PAPERCLIP_HEURISTIC_DECISION_TICK_MS ?? 750);
const BRIDGE_HEURISTIC_MANUAL_CLIP_TICK_MS = Number(process.env.PAPERCLIP_HEURISTIC_MANUAL_CLIP_TICK_MS ?? 125);
const BRIDGE_HEURISTIC_TICK_HEARTBEAT_MS = 15_000;
const DEFAULT_ATTRACT_TITLE = process.env.PAPERCLIP_DEFAULT_ATTRACT_TITLE ?? "Paperclip Battler";
const DEFAULT_ATTRACT_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.PAPERCLIP_DEFAULT_ATTRACT ?? "1").toLowerCase()
);
const DEFAULT_ATTRACT_RESTART_DELAY_MS = Number(process.env.PAPERCLIP_DEFAULT_ATTRACT_RESTART_DELAY_MS ?? 1_000);
const ATTRACT_BROWSER_RESTART_MS = Number(process.env.PAPERCLIP_ATTRACT_BROWSER_RESTART_MS ?? 3_000);
const MAX_JSON_BODY_SIZE = 5_000_000;
const PAPERCLIP_CLICK_RATE_LIMIT_LABEL = "10 clicks per second per session";
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PAULS_INSTRUCTION_PATHS = [
  process.env.PAULS_AGENT_AI_INSTRUCTIONS_PATH,
  join(process.cwd(), "docs", "pauls-agent-ai-instructions.md"),
  join(SERVER_DIR, "..", "docs", "pauls-agent-ai-instructions.md"),
  join(SERVER_DIR, "..", "..", "docs", "pauls-agent-ai-instructions.md")
].filter(Boolean) as string[];
const CODEX_INSTRUCTION_PATHS = [
  process.env.CODEX_AGENT_AI_INSTRUCTIONS_PATH,
  join(process.cwd(), "docs", "codex-agent-ai-instructions.md"),
  join(SERVER_DIR, "..", "docs", "codex-agent-ai-instructions.md"),
  join(SERVER_DIR, "..", "..", "docs", "codex-agent-ai-instructions.md")
].filter(Boolean) as string[];
const INSTRUCTION_MODES = ["none", "paul", "codex"] as const;
const PLAYER_IDS = ["left", "right"] as const;
const PLAYER_REF_VALUES = ["left", "right", "player", "agent", "p1", "p2", "1", "2"] as const;
const PLAYER_MODES = ["human", "agent", "heuristic", "both"] as const;

type InstructionMode = (typeof INSTRUCTION_MODES)[number];
type PlayerId = (typeof PLAYER_IDS)[number];
type PlayerRef = (typeof PLAYER_REF_VALUES)[number];
type PlayerMode = (typeof PLAYER_MODES)[number];
type PlayerAssetMode = "player" | "spectator";
type StoragePartitionMode = "player" | "spectator";
type RoomParticipantRole = "player" | "observer";

type RateLimitPolicy = {
  name: string;
  windowMs: number;
  max: number;
  message: string;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type RateLimitTarget = {
  policy: RateLimitPolicy;
  keyParts: Array<string | number | undefined>;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
  message: string;
};

type ClosedRoomRecord = {
  roomId: string;
  completedAt: number | null;
  expiresAt: number | null;
  closedAt: number;
  reason: string;
};

type RoomWarningKind = "idle" | "max-age";

type RoomWarning = {
  kind: RoomWarningKind;
  message: string;
  action: string | null;
  issuedAt: number;
  closesAt: number;
  ttlMs: number;
};

class RateLimitError extends Error {
  retryAfterMs: number;

  constructor(result: RateLimitResult) {
    super(result.message);
    this.name = "RateLimitError";
    this.retryAfterMs = result.retryAfterMs;
  }
}

class RoomClosedError extends Error {
  room: ClosedRoomRecord;

  constructor(room: ClosedRoomRecord) {
    super(`Lobby ${room.roomId} has closed.`);
    this.name = "RoomClosedError";
    this.room = room;
  }
}

const PLAYER_LABELS: Record<PlayerId, string> = {
  left: "Player 1",
  right: "Player 2"
};

const DEFAULT_PLAYER_MODES: Record<PlayerId, PlayerMode> = {
  left: "human",
  right: "agent"
};

const RATE_LIMITS = {
  paperclipClick: {
    name: "paperclip-click",
    windowMs: 1_000,
    max: 10,
    message: `Paperclipper rate limit exceeded: ${PAPERCLIP_CLICK_RATE_LIMIT_LABEL}.`
  },
  playerControl: {
    name: "player-control",
    windowMs: 1_000,
    max: 30,
    message: "Too many requests. Please try again shortly."
  },
  bridgeRead: {
    name: "bridge-read",
    windowMs: 60_000,
    max: 180,
    message: "Too many requests. Please try again shortly."
  },
  bridgeWrite: {
    name: "bridge-write",
    windowMs: 60_000,
    max: 60,
    message: "Too many requests. Please try again shortly."
  },
  bridgeBulkWrite: {
    name: "bridge-bulk-write",
    windowMs: 60_000,
    max: 12,
    message: "Too many requests. Please try again shortly."
  },
  bridgeCommand: {
    name: "bridge-command",
    windowMs: 60_000,
    max: 30,
    message: "Too many requests. Please try again shortly."
  },
  assetProxy: {
    name: "asset-proxy",
    windowMs: 60_000,
    max: 240,
    message: "Too many requests. Please try again shortly."
  },
  eventStream: {
    name: "event-stream",
    windowMs: 60_000,
    max: 30,
    message: "Too many requests. Please try again shortly."
  },
  fallback: {
    name: "bridge",
    windowMs: 60_000,
    max: 240,
    message: "Too many requests. Please try again shortly."
  }
} satisfies Record<string, RateLimitPolicy>;

type AgentButton = {
  id: string;
  index: number;
  text: string;
  disabled: boolean;
  visible: boolean;
  selector: string;
  elementId: string | null;
  title: string;
  value: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

type AgentControl = {
  id: string;
  index: number;
  tag: string;
  type: string;
  label: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  visible: boolean;
  selector: string;
  elementId: string | null;
  options?: string[];
};

type AgentReport = {
  at: number;
  lastUserActivityAt?: number;
  url: string;
  title: string;
  buttons: AgentButton[];
  controls: AgentControl[];
  visibleText: string;
  save?: PlayerBrowserSave;
};

type AgentCommand =
  | {
      id: string;
      type: "click";
      buttonId?: string;
      selector?: string;
      text?: string;
    }
  | {
      id: string;
      type: "set-control";
      controlId?: string;
      selector?: string;
      value: string;
    }
  | {
      id: string;
      type: "reset";
    }
  | {
      id: string;
      type: "import-save";
      save: PlayerBrowserSave;
    };

type AgentCommandResult = {
  id: string;
  ok: boolean;
  message: string;
  at: number;
};

type PlayerState = {
  mode: PlayerMode;
  ready: boolean;
  latestReport: AgentReport | null;
  pendingCommand: AgentCommand | null;
  claim: PlayerClaim | null;
};

type PlayerBrowserSave = {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
};

type PlayerClaim = {
  token: string;
  label: string;
  source: "mcp" | "http";
  claimedAt: number;
  lastSeenAt: number;
  expiresAt: number;
};

type RoomParticipant = {
  sessionId: string;
  role: RoomParticipantRole;
  player: PlayerId | null;
  joinedAt: number;
  lastSeenAt: number;
};

type RoomEvent = {
  id: number;
  roomId: string;
  type: string;
  at: number;
  payload: unknown;
};

type RoomState = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  idleWarningSentAt: number | null;
  maxAgeWarningSentAt: number | null;
  gameStartedAt: number | null;
  completedAt: number | null;
  expiresAt: number | null;
  tinyState: Record<string, unknown>;
  playerStates: Map<PlayerId, PlayerState>;
  participants: Map<string, RoomParticipant>;
  nextEventId: number;
  sseClients: Set<ServerResponse>;
};

type BrowserCommand = {
  command: string;
  args: string[];
};

type DefaultAttractRuntime = {
  roomId: string;
  browsers: Array<ReturnType<typeof spawn>>;
  profileDirs: string[];
  startedAt: number;
  stopping: boolean;
  gameOverAt: number | null;
  lastError: string | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
};

const closedRooms = new Map<string, ClosedRoomRecord>();
const rooms = new Map<string, RoomState>([[DEFAULT_ROOM_ID, createRoomState(DEFAULT_ROOM_ID, "Local Room")]]);

let instructionMode: InstructionMode = "none";
let defaultLobby: { roomId: string; createdAt: number } | null = null;
let defaultAttractRuntime: DefaultAttractRuntime | null = null;
let defaultAttractLaunch: Promise<void> | null = null;
let roomCleanupTimer: ReturnType<typeof setInterval> | null = null;
let lastRateLimitCleanupAt = Date.now();
const rateLimitBuckets = new Map<string, RateLimitBucket>();
const commandWaiters = new Map<string, (result: AgentCommandResult) => void>();

const mcpServer = new McpServer({
  name: "paperclip-battler",
  version: "0.2.0"
});

mcpServer.registerResource(
  "agent-page-state",
  "paperclip://agent/page-state",
  {
    title: "Agent Page State",
    description: "Live DOM inventory reported by the MCP-controlled Universal Paperclips agent pane.",
    mimeType: "application/json"
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(getBridgeState(), null, 2)
      }
    ]
  })
);

mcpServer.registerResource(
  "pauls-agent-ai-instructions",
  "paperclip://agent/pauls-ai-instructions",
  {
    title: "Paul's Agent AI Instructions",
    description: "Optional Paul-flavored playbook for Paperclip Battler agent play.",
    mimeType: "text/markdown"
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: getPaulsAgentInstructions()
      }
    ]
  })
);

mcpServer.registerTool(
  "pauls_agent_ai_instructions",
  {
    title: "Paul's Agent AI Instructions",
    description: "Optionally read Paul's instructions for the Agent side of Paperclip Battler.",
    inputSchema: {}
  },
  async () => {
    instructionMode = "paul";
    return {
      content: [
        {
          type: "text" as const,
          text: getPaulsAgentInstructions()
        }
      ]
    };
  }
);

mcpServer.registerResource(
  "codex-agent-ai-instructions",
  "paperclip://agent/codex-ai-instructions",
  {
    title: "Codex Agent AI Instructions",
    description: "Codex's self-maintained operating notes for Paperclip Battler agent play.",
    mimeType: "text/markdown"
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: getCodexAgentInstructions()
      }
    ]
  })
);

mcpServer.registerTool(
  "codex_agent_ai_instructions",
  {
    title: "Codex Agent AI Instructions",
    description: "Optionally read Codex's self-maintained operating notes for playing or improving the agent side.",
    inputSchema: {}
  },
  async () => {
    instructionMode = "codex";
    return {
      content: [
        {
          type: "text" as const,
          text: getCodexAgentInstructions()
        }
      ]
    };
  }
);

mcpServer.registerTool(
  "set_agent_instruction_mode",
  {
    title: "Set Agent Instruction Mode",
    description: "Set which optional instruction playbook is currently being used: none, Paul, or Codex.",
    inputSchema: {
      mode: z.enum(INSTRUCTION_MODES).describe("Instruction mode to show in the UI.")
    }
  },
  async ({ mode }) => {
    instructionMode = mode;
    return textJson({ ok: true, instructionMode, instructionLabel: instructionModeLabel(instructionMode) });
  }
);

mcpServer.registerTool(
  "get_agent_page_state",
  {
    title: "Get Agent Page State",
    description: "Read visible page text, buttons, controls, and connection status for one or both bridged players.",
    inputSchema: {
      room: z.string().optional().describe("Room id. Defaults to the local room."),
      player: z.enum(PLAYER_REF_VALUES).optional().describe("Target player. Defaults to the full two-player bridge state."),
      claimToken: z.string().optional().describe("Existing claim token for this player."),
      controller: z.string().optional().describe("Human-readable controller name used when auto-claiming a free player.")
    }
  },
  async ({ room, player, claimToken, controller }) => {
    const roomId = normalizeRoomId(room);
    if (!player) return textJson(getBridgeState(roomId));
    const playerId = normalizePlayerId(player);
    const claim = maybeEnsurePlayerClaim(roomId, playerId, { claimToken, controller, source: "mcp" });
    return textJson({ room: serializeRoom(roomId), player: getPlayerBridgeState(roomId, playerId), claim: serializeClaim(claim, true) });
  }
);

mcpServer.registerTool(
  "claim_agent_player",
  {
    title: "Claim Agent Player",
    description: "Claim an agent-capable player for this MCP controller and receive a token for follow-up calls.",
    inputSchema: {
      room: z.string().optional().describe("Room id. Defaults to the local room."),
      player: z.enum(PLAYER_REF_VALUES).default("right").describe("Target player to claim."),
      claimToken: z.string().optional().describe("Existing claim token to refresh."),
      controller: z.string().optional().describe("Human-readable controller name to show in the UI.")
    }
  },
  async ({ room, player, claimToken, controller }) => {
    const roomId = normalizeRoomId(room);
    const playerId = normalizePlayerId(player);
    const claim = ensurePlayerClaim(roomId, playerId, { claimToken, controller, source: "mcp" });
    markRoomActivity(roomId);
    return textJson({ room: serializeRoom(roomId), player: getPlayerMeta(roomId, playerId), claim: serializeClaim(claim, true) });
  }
);

mcpServer.registerTool(
  "release_agent_player",
  {
    title: "Release Agent Player",
    description: "Release an MCP controller claim using the matching token.",
    inputSchema: {
      room: z.string().optional().describe("Room id. Defaults to the local room."),
      player: z.enum(PLAYER_REF_VALUES).default("right").describe("Target player to release."),
      claimToken: z.string().describe("Claim token returned by claim_agent_player or an auto-claiming tool.")
    }
  },
  async ({ room, player, claimToken }) => {
    const roomId = normalizeRoomId(room);
    const playerId = normalizePlayerId(player);
    releasePlayerClaim(roomId, playerId, claimToken);
    markRoomActivity(roomId);
    emitRoomEvent(roomId, "room", { player: getPlayerMeta(roomId, playerId) });
    return textJson({ ok: true, room: serializeRoom(roomId), player: getPlayerMeta(roomId, playerId) });
  }
);

mcpServer.registerTool(
  "set_agent_player_ready",
  {
    title: "Set Agent Player Ready",
    description: "Mark a player ready or not ready. Action commands remain blocked until both players are ready.",
    inputSchema: {
      room: z.string().optional().describe("Room id. Defaults to the local room."),
      player: z.enum(PLAYER_REF_VALUES).default("right").describe("Target player to mark ready."),
      ready: z.boolean().default(true).describe("Whether this player is ready."),
      claimToken: z.string().optional().describe("Existing claim token for this player, if it is claimed.")
    }
  },
  async ({ room, player, ready, claimToken }) => {
    const roomId = normalizeRoomId(room);
    const playerId = normalizePlayerId(player);
    assertReadyChangeAllowed(roomId, playerId, claimToken, false);
    setPlayerReadyState(roomId, playerId, ready);
    markRoomActivity(roomId);
    emitRoomEvent(roomId, "room", { player: getPlayerMeta(roomId, playerId), allPlayersReady: allPlayersReady(roomId) });
    return textJson({
      ok: true,
      room: serializeRoom(roomId),
      allPlayersReady: allPlayersReady(roomId),
      player: getPlayerMeta(roomId, playerId),
      players: getPlayerModes(roomId)
    });
  }
);

mcpServer.registerTool(
  "list_agent_buttons",
  {
    title: "List Agent Buttons",
    description: "List visible buttons currently available to the agent for the selected player.",
    inputSchema: {
      room: z.string().optional().describe("Room id. Defaults to the local room."),
      player: z.enum(PLAYER_REF_VALUES).default("right").describe("Target player to inspect."),
      claimToken: z.string().optional().describe("Existing claim token for this player."),
      controller: z.string().optional().describe("Human-readable controller name used when auto-claiming a free player."),
      includeDisabled: z.boolean().default(false).describe("Include disabled buttons too.")
    }
  },
  async ({ room, player, claimToken, controller, includeDisabled }) => {
    const roomId = normalizeRoomId(room);
    const playerId = normalizePlayerId(player);
    const buttons = getFreshReport(roomId, playerId).buttons.filter((button) => includeDisabled || !button.disabled);
    const claim = maybeEnsurePlayerClaim(roomId, playerId, { claimToken, controller, source: "mcp" });
    return textJson({ room: serializeRoom(roomId), player: getPlayerMeta(roomId, playerId), claim: serializeClaim(claim, true), buttons });
  }
);

mcpServer.registerTool(
  "click_agent_button",
  {
    title: "Click Agent Button",
    description: "Click one visible button for the selected agent-capable player by id, index, or text.",
    inputSchema: {
      room: z.string().optional().describe("Room id. Defaults to the local room."),
      player: z.enum(PLAYER_REF_VALUES).default("right").describe("Target player to click."),
      claimToken: z.string().optional().describe("Existing claim token for this player."),
      controller: z.string().optional().describe("Human-readable controller name used when auto-claiming a free player."),
      buttonId: z.string().optional().describe("Button id returned by list_agent_buttons."),
      index: z.number().int().min(0).optional().describe("Button index returned by list_agent_buttons."),
      text: z.string().optional().describe("Visible button text to match, case-insensitive.")
    }
  },
  async ({ room, player, claimToken, controller, buttonId, index, text }) => {
    const roomId = normalizeRoomId(room);
    const playerId = normalizePlayerId(player);
    assertActionReady(roomId, playerId);
    const button = resolveButton(roomId, playerId, { buttonId, index, text });
    const claim = ensurePlayerClaim(roomId, playerId, { claimToken, controller, source: "mcp" });
    const result = await queueCommand(roomId, playerId, {
      id: randomUUID(),
      type: "click",
      buttonId: button.id,
      selector: button.selector,
      text: button.text
    });
    return textJson({
      room: serializeRoom(roomId),
      player: getPlayerMeta(roomId, playerId),
      claim: serializeClaim(claim, true),
      button,
      result,
      state: summarizeReport(getPlayerState(roomId, playerId).latestReport)
    });
  }
);

mcpServer.registerTool(
  "list_agent_controls",
  {
    title: "List Agent Controls",
    description: "List visible form controls such as selects, text fields, checkboxes, and sliders for the selected player.",
    inputSchema: {
      room: z.string().optional().describe("Room id. Defaults to the local room."),
      player: z.enum(PLAYER_REF_VALUES).default("right").describe("Target player to inspect."),
      claimToken: z.string().optional().describe("Existing claim token for this player."),
      controller: z.string().optional().describe("Human-readable controller name used when auto-claiming a free player."),
      includeDisabled: z.boolean().default(false).describe("Include disabled controls too.")
    }
  },
  async ({ room, player, claimToken, controller, includeDisabled }) => {
    const roomId = normalizeRoomId(room);
    const playerId = normalizePlayerId(player);
    const controls = getFreshReport(roomId, playerId).controls.filter((control) => includeDisabled || !control.disabled);
    const claim = maybeEnsurePlayerClaim(roomId, playerId, { claimToken, controller, source: "mcp" });
    return textJson({ room: serializeRoom(roomId), player: getPlayerMeta(roomId, playerId), claim: serializeClaim(claim, true), controls });
  }
);

mcpServer.registerTool(
  "set_agent_control",
  {
    title: "Set Agent Control",
    description: "Set a visible input, select, checkbox, or slider value for the selected agent-capable player.",
    inputSchema: {
      room: z.string().optional().describe("Room id. Defaults to the local room."),
      player: z.enum(PLAYER_REF_VALUES).default("right").describe("Target player to update."),
      claimToken: z.string().optional().describe("Existing claim token for this player."),
      controller: z.string().optional().describe("Human-readable controller name used when auto-claiming a free player."),
      controlId: z.string().optional().describe("Control id returned by list_agent_controls."),
      index: z.number().int().min(0).optional().describe("Control index returned by list_agent_controls."),
      label: z.string().optional().describe("Visible label or element id to match, case-insensitive."),
      value: z.string().describe("Value to apply. For checkboxes use true or false.")
    }
  },
  async ({ room, player, claimToken, controller, controlId, index, label, value }) => {
    const roomId = normalizeRoomId(room);
    const playerId = normalizePlayerId(player);
    assertActionReady(roomId, playerId);
    const control = resolveControl(roomId, playerId, { controlId, index, label });
    const claim = ensurePlayerClaim(roomId, playerId, { claimToken, controller, source: "mcp" });
    const result = await queueCommand(roomId, playerId, {
      id: randomUUID(),
      type: "set-control",
      controlId: control.id,
      selector: control.selector,
      value
    });
    return textJson({
      room: serializeRoom(roomId),
      player: getPlayerMeta(roomId, playerId),
      claim: serializeClaim(claim, true),
      control,
      result,
      state: summarizeReport(getPlayerState(roomId, playerId).latestReport)
    });
  }
);

mcpServer.registerTool(
  "reset_agent_page",
  {
    title: "Reset Agent Page",
    description: "Clear browser storage for the selected bridged player and reload it.",
    inputSchema: {
      room: z.string().optional().describe("Room id. Defaults to the local room."),
      player: z.enum(PLAYER_REF_VALUES).default("right").describe("Target player to reset."),
      claimToken: z.string().optional().describe("Existing claim token for this player."),
      controller: z.string().optional().describe("Human-readable controller name used when auto-claiming a free player.")
    }
  },
  async ({ room, player, claimToken, controller }) => {
    const roomId = normalizeRoomId(room);
    const playerId = normalizePlayerId(player);
    getFreshReport(roomId, playerId);
    const claim = ensurePlayerClaim(roomId, playerId, { claimToken, controller, source: "mcp" });
    const result = await queueCommand(roomId, playerId, { id: randomUUID(), type: "reset" });
    return textJson({
      room: serializeRoom(roomId),
      player: getPlayerMeta(roomId, playerId),
      claim: serializeClaim(claim, true),
      result,
      state: summarizeReport(getPlayerState(roomId, playerId).latestReport)
    });
  }
);

startBridge();

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
process.once("SIGINT", shutdownBridgeProcess);
process.once("SIGTERM", shutdownBridgeProcess);

function shutdownBridgeProcess() {
  stopDefaultAttractRuntime();
  if (roomCleanupTimer) clearInterval(roomCleanupTimer);
  process.exit(0);
}

function startBridge() {
  startRoomCleanupTimer();

  const server = createServer(async (request, response) => {
    setCors(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    try {
      if (!applyGatewayRateLimit(request, response, url)) return;

      if (request.method === "GET" && url.pathname === "/lobbies/default") {
        sendJson(response, 200, { ok: true, ...serializeDefaultLobby(getDefaultLobbyRoom()) });
        return;
      }

      if (request.method === "POST" && (url.pathname === "/lobbies/default" || url.pathname === "/lobbies/default/rotate")) {
        const body = await readJsonBody<{ title?: string }>(request);
        sendJson(response, 201, { ok: true, ...serializeDefaultLobby(rotateDefaultLobby(body.title)) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/rooms") {
        sendJson(response, 200, { ok: true, rooms: Array.from(rooms.keys()).map((roomId) => serializeRoom(roomId)) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/rooms") {
        const body = await readJsonBody<{ id?: string; title?: string; tinyState?: Record<string, unknown> }>(request);
        const roomId = body.id ? normalizeRoomId(body.id) : createShortRoomId();
        const room = getRoomState(roomId, body.title, { reopenClosed: true });
        if (body.title) room.title = normalizeRoomTitle(body.title, roomId);
        if (isRecord(body.tinyState)) room.tinyState = body.tinyState;
        markRoomActivity(roomId);
        touchRoom(roomId);
        emitRoomEvent(roomId, "room", { room: serializeRoom(roomId) });
        sendJson(response, 201, { ok: true, room: serializeRoom(roomId) });
        return;
      }

      const roomPath = parseRoomPath(url.pathname);
      if (roomPath && (await handleRoomPath(roomPath, request, response, url))) {
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const roomId = resolveUrlRoomId(url);
        sendJson(response, 200, getBridgeState(roomId));
        return;
      }

      if (request.method === "GET" && url.pathname === "/state") {
        const roomId = resolveUrlRoomId(url);
        sendJson(response, 200, getBridgeState(roomId));
        return;
      }

      if (request.method === "GET" && url.pathname === "/buttons") {
        const roomId = resolveUrlRoomId(url);
        const playerId = normalizePlayerId(url.searchParams.get("player") ?? "right");
        sendJson(response, 200, getPlayerState(roomId, playerId).latestReport?.buttons ?? []);
        return;
      }

      if (request.method === "GET" && url.pathname === "/instructions/mode") {
        sendJson(response, 200, { ok: true, instructionMode, instructionLabel: instructionModeLabel(instructionMode) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/instructions/mode") {
        const body = await readJsonBody<{ mode?: string }>(request);
        instructionMode = normalizeInstructionMode(body.mode);
        sendJson(response, 200, { ok: true, instructionMode, instructionLabel: instructionModeLabel(instructionMode) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/players/mode") {
        const roomId = resolveUrlRoomId(url);
        sendJson(response, 200, { ok: true, room: serializeRoom(roomId), players: getPlayerModes(roomId) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/players/mode") {
        const body = await readJsonBody<{ room?: string; player?: string; mode?: string }>(request);
        const roomId = resolveBodyRoomId(url, body);
        const playerId = normalizePlayerId(body.player ?? url.searchParams.get("player") ?? "right");
        const mode = normalizePlayerMode(body.mode);
        getPlayerState(roomId, playerId).mode = mode;
        markRoomActivity(roomId);
        touchRoom(roomId);
        emitRoomEvent(roomId, "room", { player: getPlayerMeta(roomId, playerId) });
        sendJson(response, 200, { ok: true, room: serializeRoom(roomId), player: getPlayerMeta(roomId, playerId), players: getPlayerModes(roomId) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/players/ready") {
        const roomId = resolveUrlRoomId(url);
        sendJson(response, 200, { ok: true, room: serializeRoom(roomId), allPlayersReady: allPlayersReady(roomId), players: getPlayerModes(roomId) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/players/ready") {
        const body = await readJsonBody<{ room?: string; player?: string; ready?: boolean; claimToken?: string; force?: boolean }>(request);
        const roomId = resolveBodyRoomId(url, body);
        const playerId = normalizePlayerId(body.player ?? url.searchParams.get("player") ?? "right");
        assertReadyChangeAllowed(roomId, playerId, body.claimToken, Boolean(body.force));
        setPlayerReadyState(roomId, playerId, Boolean(body.ready));
        markRoomActivity(roomId);
        touchRoom(roomId);
        emitRoomEvent(roomId, "room", { player: getPlayerMeta(roomId, playerId), allPlayersReady: allPlayersReady(roomId) });
        sendJson(response, 200, {
          ok: true,
          room: serializeRoom(roomId),
          allPlayersReady: allPlayersReady(roomId),
          player: getPlayerMeta(roomId, playerId),
          players: getPlayerModes(roomId)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/players/ready/reset") {
        const body = await readJsonBody<{ room?: string }>(request);
        const roomId = resolveBodyRoomId(url, body);
        for (const playerId of PLAYER_IDS) {
          assertReadyChangeAllowed(roomId, playerId, undefined, true);
        }
        setAllPlayersReadyState(roomId, false);
        markRoomActivity(roomId);
        touchRoom(roomId);
        emitRoomEvent(roomId, "room", { allPlayersReady: false, players: getPlayerModes(roomId) });
        sendJson(response, 200, { ok: true, room: serializeRoom(roomId), allPlayersReady: false, players: getPlayerModes(roomId) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/players/claim") {
        const roomId = resolveUrlRoomId(url);
        const playerId = normalizePlayerId(url.searchParams.get("player") ?? "right");
        sendJson(response, 200, { ok: true, room: serializeRoom(roomId), player: getPlayerMeta(roomId, playerId), claim: serializeClaim(getActiveClaim(roomId, playerId), false) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/players/claim") {
        const body = await readJsonBody<{ room?: string; player?: string; claimToken?: string; controller?: string }>(request);
        const roomId = resolveBodyRoomId(url, body);
        const playerId = normalizePlayerId(body.player ?? url.searchParams.get("player") ?? "right");
        const claim = ensurePlayerClaim(roomId, playerId, {
          claimToken: body.claimToken,
          controller: body.controller,
          source: "http"
        });
        markRoomActivity(roomId);
        touchRoom(roomId);
        emitRoomEvent(roomId, "room", { player: getPlayerMeta(roomId, playerId) });
        sendJson(response, 200, { ok: true, room: serializeRoom(roomId), player: getPlayerMeta(roomId, playerId), claim: serializeClaim(claim, true) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/players/claim/release") {
        const body = await readJsonBody<{ room?: string; player?: string; claimToken?: string; force?: boolean }>(request);
        const roomId = resolveBodyRoomId(url, body);
        const playerId = normalizePlayerId(body.player ?? url.searchParams.get("player") ?? "right");
        releasePlayerClaim(roomId, playerId, body.force ? undefined : body.claimToken, Boolean(body.force));
        markRoomActivity(roomId);
        touchRoom(roomId);
        emitRoomEvent(roomId, "room", { player: getPlayerMeta(roomId, playerId) });
        sendJson(response, 200, { ok: true, room: serializeRoom(roomId), player: getPlayerMeta(roomId, playerId), claim: null });
        return;
      }

      if (request.method === "POST" && url.pathname === "/command/click") {
        const body = await readJsonBody<{
          room?: string;
          player?: string;
          claimToken?: string;
          controller?: string;
          buttonId?: string;
          index?: number;
          text?: string;
        }>(request);
        const roomId = resolveBodyRoomId(url, body);
        const playerId = normalizePlayerId(body.player ?? url.searchParams.get("player") ?? "right");
        assertActionReady(roomId, playerId);
        const button = resolveButton(roomId, playerId, body);
        const claim = ensurePlayerClaim(roomId, playerId, {
          claimToken: body.claimToken,
          controller: body.controller,
          source: "http"
        });
        const result = await queueCommand(roomId, playerId, {
          id: randomUUID(),
          type: "click",
          buttonId: button.id,
          selector: button.selector,
          text: button.text
        });
        sendJson(response, 200, {
          ok: result.ok,
          room: serializeRoom(roomId),
          player: getPlayerMeta(roomId, playerId),
          claim: serializeClaim(claim, true),
          button,
          result,
          state: summarizeReport(getPlayerState(roomId, playerId).latestReport)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/command/set-control") {
        const body = await readJsonBody<{
          room?: string;
          player?: string;
          claimToken?: string;
          controller?: string;
          controlId?: string;
          index?: number;
          label?: string;
          value?: string;
        }>(request);
        const roomId = resolveBodyRoomId(url, body);
        const playerId = normalizePlayerId(body.player ?? url.searchParams.get("player") ?? "right");
        assertActionReady(roomId, playerId);
        const control = resolveControl(roomId, playerId, body);
        const claim = ensurePlayerClaim(roomId, playerId, {
          claimToken: body.claimToken,
          controller: body.controller,
          source: "http"
        });
        const result = await queueCommand(roomId, playerId, {
          id: randomUUID(),
          type: "set-control",
          controlId: control.id,
          selector: control.selector,
          value: String(body.value ?? "")
        });
        sendJson(response, 200, {
          ok: result.ok,
          room: serializeRoom(roomId),
          player: getPlayerMeta(roomId, playerId),
          claim: serializeClaim(claim, true),
          control,
          result,
          state: summarizeReport(getPlayerState(roomId, playerId).latestReport)
        });
        return;
      }

      if (request.method === "GET" && (url.pathname === "/player-control/config" || url.pathname === "/agent-control/config")) {
        const roomId = resolveUrlRoomId(url);
        const playerId = normalizePlayerId(url.searchParams.get("player") ?? "right");
        sendJson(response, 200, {
          ok: true,
          room: serializeRoom(roomId),
          player: getPlayerMeta(roomId, playerId),
          allPlayersReady: allPlayersReady(roomId)
        });
        return;
      }

      if (request.method === "POST" && (url.pathname === "/player-control/report" || url.pathname === "/agent-control/report")) {
        const roomId = resolveUrlRoomId(url);
        const playerId = normalizePlayerId(url.searchParams.get("player") ?? "right");
        const report = normalizeReport(await readJsonBody<AgentReport>(request));
        getPlayerState(roomId, playerId).latestReport = report;
        if (report.lastUserActivityAt) markRoomActivity(roomId, report.lastUserActivityAt);
        touchRoom(roomId);
        emitRoomEvent(roomId, "snapshot", { player: getPlayerMeta(roomId, playerId), report: summarizeReport(report) });
        handleDefaultAttractReport(roomId, playerId, report);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && (url.pathname === "/player-control/heuristic-ticks" || url.pathname === "/agent-control/heuristic-ticks")) {
        const roomId = resolveUrlRoomId(url);
        const playerId = normalizePlayerId(url.searchParams.get("player") ?? "right");
        subscribeHeuristicTicks(roomId, playerId, request, response);
        return;
      }

      if (request.method === "GET" && (url.pathname === "/player-control/next-command" || url.pathname === "/agent-control/next-command")) {
        const roomId = resolveUrlRoomId(url);
        const playerId = normalizePlayerId(url.searchParams.get("player") ?? "right");
        const state = getPlayerState(roomId, playerId);
        const command = state.pendingCommand;
        state.pendingCommand = null;
        sendJson(response, 200, command ?? { id: null, type: "none" });
        return;
      }

      if (request.method === "POST" && (url.pathname === "/player-control/result" || url.pathname === "/agent-control/result")) {
        const result = await readJsonBody<AgentCommandResult>(request);
        completeCommand(result);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && (url.pathname === "/player-control/manual-reset" || url.pathname === "/agent-control/manual-reset")) {
        const roomId = resolveUrlRoomId(url);
        const playerId = normalizePlayerId(url.searchParams.get("player") ?? "right");
        const state = getPlayerState(roomId, playerId);
        setPlayerReadyState(roomId, playerId, false);
        state.pendingCommand = { id: randomUUID(), type: "reset" };
        state.latestReport = null;
        markRoomActivity(roomId);
        touchRoom(roomId);
        emitRoomEvent(roomId, "room", { player: getPlayerMeta(roomId, playerId), allPlayersReady: allPlayersReady(roomId) });
        sendJson(response, 200, { ok: true, room: serializeRoom(roomId), player: getPlayerMeta(roomId, playerId) });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/players/")) {
        await proxyPlayerAsset(url, response, undefined, resolveUrlRoomId(url));
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/agent/")) {
        await proxyPlayerAsset(url, response, "right", resolveUrlRoomId(url));
        return;
      }

      sendJson(response, 404, { ok: false, message: "Not found." });
    } catch (error) {
      if (error instanceof RateLimitError) {
        sendRateLimitError(response, error);
        return;
      }

      if (error instanceof RoomClosedError) {
        sendJson(response, 410, {
          ok: false,
          message: error.message,
          roomId: error.room.roomId,
          completedAt: error.room.completedAt,
          expiresAt: error.room.expiresAt,
          closedAt: error.room.closedAt,
          reason: error.room.reason
        });
        return;
      }

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

async function handleRoomPath(
  roomPath: { kind: "rooms" | "watch"; roomId: string; rest: string },
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  const roomId = roomPath.roomId;
  getRoomState(roomId);

  if (request.method === "GET" && roomPath.rest === "/") {
    sendJson(response, 200, { ...getBridgeState(roomId), role: roomPath.kind === "watch" ? "spectator" : "player" });
    return true;
  }

  if (request.method === "POST" && roomPath.kind === "rooms" && roomPath.rest === "/participants") {
    const body = await readJsonBody<{ sessionId?: string }>(request);
    const participant = joinRoomParticipant(roomId, body.sessionId);
    sendJson(response, 200, {
      ok: true,
      room: serializeRoom(roomId),
      participant: serializeRoomParticipant(participant, true)
    });
    return true;
  }

  if (request.method === "POST" && roomPath.kind === "rooms" && roomPath.rest === "/participants/heartbeat") {
    const body = await readJsonBody<{ sessionId?: string }>(request);
    const participant = heartbeatRoomParticipant(roomId, body.sessionId);
    sendJson(response, 200, {
      ok: true,
      room: serializeRoom(roomId),
      participant: serializeRoomParticipant(participant, true)
    });
    return true;
  }

  if (request.method === "POST" && roomPath.kind === "rooms" && roomPath.rest === "/participants/leave") {
    const body = await readJsonBody<{ sessionId?: string }>(request);
    leaveRoomParticipant(roomId, body.sessionId);
    sendJson(response, 200, { ok: true, room: serializeRoom(roomId) });
    return true;
  }

  if (request.method === "POST" && roomPath.kind === "rooms" && roomPath.rest === "/activity") {
    const body = await readJsonBody<{ at?: number }>(request);
    markRoomActivity(roomId, typeof body.at === "number" ? body.at : Date.now());
    emitRoomEvent(roomId, "room", { room: serializeRoom(roomId), activity: true });
    sendJson(response, 200, { ok: true, room: serializeRoom(roomId) });
    return true;
  }

  if (request.method === "GET" && roomPath.kind === "rooms" && roomPath.rest === "/events") {
    subscribeRoomEvents(roomId, request, response);
    return true;
  }

  if (request.method === "GET" && roomPath.kind === "rooms" && roomPath.rest === "/snapshot") {
    sendJson(response, 200, getBridgeState(roomId));
    return true;
  }

  if (request.method === "POST" && roomPath.kind === "rooms" && roomPath.rest === "/snapshot") {
    const body = await readJsonBody<{ tinyState?: Record<string, unknown>; event?: unknown }>(request);
    const room = getRoomState(roomId);
    if (isRecord(body.tinyState)) room.tinyState = body.tinyState;
    touchRoom(roomId);
    emitRoomEvent(roomId, "snapshot", { room: serializeRoom(roomId), event: body.event ?? null });
    sendJson(response, 200, getBridgeState(roomId));
    return true;
  }

  if (request.method === "GET" && roomPath.kind === "rooms" && roomPath.rest === "/export") {
    sendJson(response, 200, getRoomExport(roomId));
    return true;
  }

  if (request.method === "POST" && roomPath.kind === "rooms" && roomPath.rest === "/import") {
    const body = await readJsonBody<unknown>(request);
    importRoomExport(roomId, body);
    sendJson(response, 200, getBridgeState(roomId));
    return true;
  }

  if (request.method === "POST" && roomPath.kind === "rooms" && roomPath.rest === "/complete") {
    const body = await readJsonBody<unknown>(request);
    const payload = isRecord(body) ? (isRecord(body.payload) ? body.payload : body) : {};
    const result = completeRoom(roomId, payload);
    sendJson(response, 200, {
      ok: true,
      room: serializeRoom(roomId),
      event: result.event,
      completedAt: result.completedAt,
      expiresAt: result.expiresAt,
      ttlMs: Math.max(0, result.expiresAt - Date.now())
    });
    return true;
  }

  if (request.method === "GET" && roomPath.kind === "rooms" && roomPath.rest === "/save") {
    sendJson(response, 200, {
      ok: true,
      room: serializeRoom(roomId),
      saves: Object.fromEntries(PLAYER_IDS.map((playerId) => [playerId, getPlayerState(roomId, playerId).latestReport?.save ?? null]))
    });
    return true;
  }

  if (request.method === "POST" && roomPath.kind === "rooms" && roomPath.rest === "/save/import") {
    const body = await readJsonBody<{ player?: string; save?: PlayerBrowserSave }>(request);
    const playerId = normalizePlayerId(body.player ?? url.searchParams.get("player") ?? "right");
    const save = normalizeBrowserSave(body.save);
    const result = await queueCommand(roomId, playerId, { id: randomUUID(), type: "import-save", save });
    sendJson(response, 200, { ok: result.ok, room: serializeRoom(roomId), player: getPlayerMeta(roomId, playerId), result });
    return true;
  }

  if (request.method === "POST" && roomPath.kind === "rooms" && roomPath.rest === "/events") {
    const body = await readJsonBody<{ type?: string; payload?: unknown }>(request);
    const type = normalizeEventType(body.type);
    const event =
      type === "game-over"
        ? completeRoom(roomId, isRecord(body.payload) ? body.payload : {}).event
        : emitRoomEvent(roomId, type, body.payload ?? null);
    sendJson(response, 200, { ok: true, room: serializeRoom(roomId), event });
    return true;
  }

  if (request.method === "GET" && roomPath.kind === "rooms" && roomPath.rest.startsWith("/players/")) {
    await proxyPlayerAsset(url, response, undefined, roomId);
    return true;
  }

  if (request.method === "GET" && roomPath.kind === "watch" && roomPath.rest.startsWith("/players/")) {
    await proxyPlayerAsset(url, response, undefined, roomId, "spectator");
    return true;
  }

  if (request.method === "GET" && roomPath.kind === "rooms" && roomPath.rest.startsWith("/agent/")) {
    await proxyPlayerAsset(url, response, "right", roomId);
    return true;
  }

  return false;
}

async function proxyPlayerAsset(
  url: URL,
  response: ServerResponse,
  fallbackPlayer?: PlayerId,
  fallbackRoomId = DEFAULT_ROOM_ID,
  assetMode: PlayerAssetMode = "player"
) {
  const roomPath = parseRoomPath(url.pathname);
  const assetPath = roomPath?.rest ?? url.pathname;
  const roomId = roomPath ? roomPath.roomId : fallbackRoomId;
  const match = fallbackPlayer ? null : assetPath.match(/^\/players\/([^/]+)\/?(.*)$/);
  const playerId = fallbackPlayer ?? normalizePlayerId(match?.[1] ?? "right");
  const relativePath = fallbackPlayer ? assetPath.replace(/^\/agent\/?/, "") || ORIGINAL_ENTRY : match?.[2] || ORIGINAL_ENTRY;
  const upstreamUrl = new URL(relativePath, ORIGINAL_BASE);
  upstreamUrl.search = url.search;
  upstreamUrl.searchParams.delete("room");

  const upstream = await fetch(upstreamUrl);
  const contentType = upstream.headers.get("content-type") ?? inferContentType(relativePath);

  if (!upstream.ok) {
    sendJson(response, upstream.status, {
      ok: false,
      message: `Original site returned ${upstream.status}.`,
      upstream: upstreamUrl.toString()
    });
    return;
  }

  if (contentType.includes("text/html")) {
    const html = await upstream.text();
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    response.end(injectPlayerController(html, roomId, playerId, assetMode));
    return;
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function injectPlayerController(html: string, roomId: string, playerId: PlayerId, assetMode: PlayerAssetMode = "player") {
  const storageScript = `<script>${createStoragePartitionScript(roomId, playerId, assetMode)}</script>`;
  const controllerScript =
    assetMode === "spectator"
      ? `<script>${createSpectatorControllerScript(roomId, playerId)}</script>`
      : `<script>${createPlayerControllerScript(roomId, playerId)}</script>`;
  const headScripts = assetMode === "spectator" ? `${storageScript}${controllerScript}` : storageScript;
  const withStorage = html.replace(/<head([^>]*)>/i, (match) => `${match}${headScripts}`);
  const htmlWithStorage = withStorage === html ? `${headScripts}${html}` : withStorage;

  if (assetMode === "spectator") return htmlWithStorage;

  if (/<\/body>/i.test(htmlWithStorage)) {
    return htmlWithStorage.replace(/<\/body>/i, () => `${controllerScript}</body>`);
  }

  return `${htmlWithStorage}${controllerScript}`;
}

function createStoragePartitionScript(roomId: string, playerId: PlayerId, partitionMode: StoragePartitionMode = "player") {
  return String.raw`
(() => {
  const ROOM_ID = ${JSON.stringify(roomId)};
  const PLAYER_ID = ${JSON.stringify(playerId)};
  const PARTITION_MODE = ${JSON.stringify(partitionMode)};
  const ROOM_PREFIX = "paperclip-battler:" + (ROOM_ID === "local" ? "" : ROOM_ID + ":");
  const PREFIX = ROOM_PREFIX + (PARTITION_MODE === "spectator" ? "watch:" + PLAYER_ID + ":" : PLAYER_ID + ":");
  const LEGACY_SPECTATOR_PREFIX = ROOM_PREFIX + PLAYER_ID + ":watch:";

  const removeKeysWithPrefix = (storage, prefix) => {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  };

  const partition = (storage) => {
    let cachedKeys = null;

    const invalidateKeys = () => {
      cachedKeys = null;
    };

    const partitionKeys = () => {
      if (cachedKeys) return cachedKeys;
      const keys = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key || !key.startsWith(PREFIX)) continue;

        const unprefixedKey = key.slice(PREFIX.length);
        if (PARTITION_MODE === "player" && unprefixedKey.startsWith("watch:")) continue;
        keys.push(unprefixedKey);
      }
      cachedKeys = keys;
      return cachedKeys;
    };

    return {
      get length() {
        return partitionKeys().length;
      },
      key(index) {
        return partitionKeys()[index] ?? null;
      },
      getItem(key) {
        return storage.getItem(PREFIX + String(key));
      },
      setItem(key, value) {
        storage.setItem(PREFIX + String(key), String(value));
        invalidateKeys();
      },
      removeItem(key) {
        storage.removeItem(PREFIX + String(key));
        invalidateKeys();
      },
      clear() {
        for (const key of partitionKeys()) storage.removeItem(PREFIX + key);
        invalidateKeys();
      }
    };
  };

  try {
    if (PARTITION_MODE === "player") {
      removeKeysWithPrefix(window.localStorage, LEGACY_SPECTATOR_PREFIX);
      removeKeysWithPrefix(window.sessionStorage, LEGACY_SPECTATOR_PREFIX);
    }

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: partition(window.localStorage)
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: partition(window.sessionStorage)
    });
  } catch {
    // The original game still works with shared browser storage if this browser refuses the override.
  }
})();
`;
}

function createPlayerControllerScript(roomId: string, playerId: PlayerId) {
  return AGENT_CONTROLLER_SCRIPT
    .replace("__PAPERCLIP_ROOM_ID__", JSON.stringify(roomId))
    .replace("__PAPERCLIP_PLAYER_ID__", JSON.stringify(playerId));
}

function createSpectatorControllerScript(roomId: string, playerId: PlayerId) {
  const initialSave = getPlayerState(roomId, playerId).latestReport?.save ?? null;
  return String.raw`
(() => {
  const ROOM_ID = ${JSON.stringify(roomId)};
  const PLAYER_ID = ${JSON.stringify(playerId)};
  const INITIAL_SAVE = ${inlineJson(initialSave)};
  const SAVE_URL = "/rooms/" + encodeURIComponent(ROOM_ID) + "/save";
  const BLOCK_EVENTS = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "touchstart",
    "touchend",
    "input",
    "change",
    "keydown"
  ];

  let lastSaveSignature = "";
  let syncInFlight = false;

  const normalizeRecord = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  };

  const normalizeSave = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      localStorage: normalizeRecord(value.localStorage),
      sessionStorage: normalizeRecord(value.sessionStorage)
    };
  };

  const saveSignature = (save) => JSON.stringify(save);

  const importStorage = (storage, values) => {
    storage.clear();
    for (const [key, value] of Object.entries(values || {})) {
      storage.setItem(key, String(value));
    }
  };

  const applySave = (value) => {
    const save = normalizeSave(value);
    if (!save) return false;
    importStorage(window.localStorage, save.localStorage);
    importStorage(window.sessionStorage, save.sessionStorage);
    lastSaveSignature = saveSignature(save);
    return true;
  };

  const readSavedGame = () => {
    try {
      const saved = JSON.parse(window.localStorage.getItem("saveGame") || "null");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : null;
    } catch {
      return null;
    }
  };

  const gameFormat = (value, decimals = 0) => {
    if (value === null || typeof value === "undefined") return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (typeof window.formatWithCommas === "function") return window.formatWithCommas(number, decimals);
    return number.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  };

  const setText = (id, value, decimals = 0) => {
    const element = document.getElementById(id);
    const text = gameFormat(value, decimals);
    if (element && text !== null) element.textContent = text;
  };

  const syncVisibleStatsFromSave = () => {
    const saved = readSavedGame();
    if (!saved) return;

    setText("wire", saved.wire);
    setText("wireCost", saved.wireCost);
    setText("clips", Math.ceil(Number(saved.clips || 0)));
    setText("funds", saved.funds, 2);
    setText("unsoldClips", saved.unsoldClips);
    setText("margin", saved.margin, 2);
    setText("clipmakerRate", Math.round(Number(saved.clipmakerRate || 0)));
    setText("clipmakerLevel2", saved.clipmakerLevel);
    setText("clipperCost", saved.clipperCost, 2);
    setText("marketingLvl", saved.marketingLvl);
    setText("adCost", saved.adCost, 2);
    if (Number.isFinite(Number(saved.demand))) setText("demand", Number(saved.demand) * 10);
  };

  const blockTrustedInput = (event) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const installStyles = () => {
    if (document.getElementById("paperclip-battler-spectator-style")) return;
    const style = document.createElement("style");
    style.id = "paperclip-battler-spectator-style";
    style.textContent = [
      'html[data-paperclip-battler-spectator="true"],',
      'html[data-paperclip-battler-spectator="true"] body {',
      "cursor: not-allowed !important;",
      "}",
      "#paperclip-battler-spectator-shield {",
      "position: fixed !important;",
      "inset: 0 !important;",
      "z-index: 2147483647 !important;",
      "cursor: not-allowed !important;",
      "background: rgba(255, 255, 255, 0) !important;",
      "touch-action: none !important;",
      "}",
      'html[data-paperclip-battler-spectator="true"] button:not(:disabled),',
      'html[data-paperclip-battler-spectator="true"] input:not([type="hidden"]):not(:disabled),',
      'html[data-paperclip-battler-spectator="true"] select:not(:disabled),',
      'html[data-paperclip-battler-spectator="true"] textarea:not(:disabled),',
      'html[data-paperclip-battler-spectator="true"] a[onclick],',
      'html[data-paperclip-battler-spectator="true"] [role="button"] {',
      "cursor: not-allowed !important;",
      "pointer-events: none !important;",
      "}"
    ].join("");
    document.head.appendChild(style);
  };

  const ensureShield = () => {
    if (!document.body || document.getElementById("paperclip-battler-spectator-shield")) return;
    const shield = document.createElement("div");
    shield.id = "paperclip-battler-spectator-shield";
    shield.setAttribute("aria-hidden", "true");
    for (const eventName of BLOCK_EVENTS) {
      shield.addEventListener(eventName, blockTrustedInput, true);
    }
    document.body.appendChild(shield);
  };

  const installInputGuards = () => {
    document.documentElement.dataset.paperclipBattlerSpectator = "true";
    installStyles();
    ensureShield();
    for (const eventName of BLOCK_EVENTS) {
      window.addEventListener(eventName, blockTrustedInput, true);
    }
  };

  const syncSave = async () => {
    if (document.hidden || syncInFlight) return;
    syncInFlight = true;
    try {
      const response = await fetch(SAVE_URL, { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      const save = normalizeSave(payload?.saves?.[PLAYER_ID]);
      if (!save) return;
      const signature = saveSignature(save);
      if (signature === lastSaveSignature) {
        syncVisibleStatsFromSave();
        return;
      }
      applySave(save);
      window.location.reload();
    } catch {
      // The bridge may be restarting.
    } finally {
      syncInFlight = false;
    }
  };

  applySave(INITIAL_SAVE);

  const start = () => {
    installInputGuards();
    syncVisibleStatsFromSave();
    syncSave();
    window.setInterval(syncSave, ${SPECTATOR_SAVE_SYNC_INTERVAL_MS});
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) syncSave();
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
`;
}

function inlineJson(value: unknown) {
  const json = JSON.stringify(value) ?? "null";
  return json.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function createPlayerStates() {
  return new Map<PlayerId, PlayerState>(
    PLAYER_IDS.map((playerId) => [
      playerId,
      {
        mode: DEFAULT_PLAYER_MODES[playerId],
        ready: false,
        latestReport: null,
        pendingCommand: null,
        claim: null
      }
    ])
  );
}

function createRoomState(roomId: string, title?: string): RoomState {
  const now = Date.now();
  return {
    id: roomId,
    title: normalizeRoomTitle(title, roomId),
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    idleWarningSentAt: null,
    maxAgeWarningSentAt: null,
    gameStartedAt: null,
    completedAt: null,
    expiresAt: null,
    tinyState: {},
    playerStates: createPlayerStates(),
    participants: new Map(),
    nextEventId: 1,
    sseClients: new Set()
  };
}

function getRoomState(roomId: string, title?: string, options: { reopenClosed?: boolean } = {}) {
  const normalized = normalizeRoomId(roomId);
  const closedRoom = closedRooms.get(normalized);
  if (closedRoom) {
    if (options.reopenClosed) {
      closedRooms.delete(normalized);
    } else {
      throw new RoomClosedError(closedRoom);
    }
  }

  let room = rooms.get(normalized);
  if (!room) {
    room = createRoomState(normalized, title);
    rooms.set(normalized, room);
  }
  return room;
}

function touchRoom(roomId: string) {
  getRoomState(roomId).updatedAt = Date.now();
}

function markRoomActivity(roomId: string, at = Date.now()) {
  const room = getRoomState(roomId);
  if (room.completedAt) return room;

  const activityAt = Math.min(Date.now(), at);
  if (activityAt <= room.lastActivityAt) return room;

  room.lastActivityAt = activityAt;
  room.updatedAt = Date.now();
  room.idleWarningSentAt = null;
  return room;
}

function getBridgeState(roomId = DEFAULT_ROOM_ID) {
  const room = getRoomState(roomId);
  const players = Object.fromEntries(PLAYER_IDS.map((playerId) => [playerId, getPlayerBridgeState(roomId, playerId)]));
  const right = players.right;
  return {
    ok: true,
    room: serializeRoom(roomId),
    roomId,
    gameStartedAt: room.gameStartedAt,
    elapsedGameMs: elapsedGameMs(room),
    roomUrl: `http://127.0.0.1:${BRIDGE_PORT}/rooms/${room.id}`,
    watchUrl: `http://127.0.0.1:${BRIDGE_PORT}/watch/${room.id}`,
    bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
    agentUrl: `http://127.0.0.1:${BRIDGE_PORT}/rooms/${room.id}/agent/${ORIGINAL_ENTRY}`,
    playerUrls: {
      left: `http://127.0.0.1:${BRIDGE_PORT}/rooms/${room.id}/players/left/${ORIGINAL_ENTRY}`,
      right: `http://127.0.0.1:${BRIDGE_PORT}/rooms/${room.id}/players/right/${ORIGINAL_ENTRY}`
    },
    instructionMode,
    instructionLabel: instructionModeLabel(instructionMode),
    allPlayersReady: allPlayersReady(roomId),
    players,
    agentConnected: right.connected,
    lastReportAt: right.lastReportAt,
    buttonCount: right.buttonCount,
    pendingCommand: right.pendingCommand,
    report: right.report
  };
}

function getDefaultLobbyRoom() {
  const now = Date.now();
  if (!defaultLobby || shouldRotateDefaultLobby(now)) {
    return rotateDefaultLobby(undefined, now);
  }

  const room = getRoomState(defaultLobby.roomId);
  ensureDefaultAttractRoom(room);
  return room;
}

function shouldRotateDefaultLobby(now = Date.now()) {
  if (!defaultLobby) return true;
  if (DEFAULT_ATTRACT_ENABLED && defaultAttractRuntime?.roomId === defaultLobby.roomId) return false;
  const room = getRoomState(defaultLobby.roomId);
  const activePlayers = getActiveRoomParticipants(room, now).filter((participant) => participant.role === "player").length;
  return activePlayers === 0 && now - defaultLobby.createdAt >= DEFAULT_LOBBY_TTL_MS;
}

function rotateDefaultLobby(title?: unknown, now = Date.now()) {
  const roomId = createShortRoomId();
  const room = getRoomState(roomId, normalizeRoomTitle(title ?? DEFAULT_ATTRACT_TITLE, roomId));
  stopDefaultAttractRuntime();
  defaultLobby = { roomId, createdAt: now };
  ensureDefaultAttractRoom(room);
  touchRoom(roomId);
  emitRoomEvent(roomId, "room", { room: serializeRoom(roomId), lobby: "default" });
  return room;
}

function serializeDefaultLobby(room: RoomState) {
  const createdAt = defaultLobby?.roomId === room.id ? defaultLobby.createdAt : room.createdAt;
  return {
    lobby: {
      id: "default",
      roomId: room.id,
      createdAt,
      rotatesAfterMs: DEFAULT_LOBBY_TTL_MS,
      participantTtlMs: ROOM_PARTICIPANT_TTL_MS,
      attract: serializeDefaultAttractRuntime()
    },
    room: serializeRoom(room.id)
  };
}

function ensureDefaultAttractRoom(room: RoomState) {
  if (!DEFAULT_ATTRACT_ENABLED) return;

  let changed = false;
  for (const playerId of PLAYER_IDS) {
    const state = getPlayerState(room.id, playerId);
    if (state.mode !== "heuristic") {
      state.mode = "heuristic";
      changed = true;
    }
    if (!state.ready) {
      state.ready = true;
      changed = true;
    }
    if (state.claim) {
      state.claim = null;
      changed = true;
    }
  }
  const clockChanged = updateGameClock(room.id);

  if (changed || clockChanged) touchRoom(room.id);
  void ensureDefaultAttractRuntime(room.id);
}

function serializeDefaultAttractRuntime() {
  const running = Boolean(
    defaultAttractRuntime?.browsers.length && defaultAttractRuntime.browsers.every((browser) => browser.exitCode === null)
  );
  return {
    enabled: DEFAULT_ATTRACT_ENABLED,
    roomId: defaultAttractRuntime?.roomId ?? null,
    running,
    startedAt: defaultAttractRuntime?.startedAt ?? null,
    lastError: defaultAttractRuntime?.lastError ?? null,
    restartDelayMs: DEFAULT_ATTRACT_RESTART_DELAY_MS
  };
}

async function ensureDefaultAttractRuntime(roomId: string, force = false) {
  if (!DEFAULT_ATTRACT_ENABLED) return;
  if (defaultAttractLaunch) {
    await defaultAttractLaunch;
    if (
      !force &&
      defaultAttractRuntime?.roomId === roomId &&
      defaultAttractRuntime.browsers.length > 0 &&
      defaultAttractRuntime.browsers.every((browser) => browser.exitCode === null)
    ) {
      return;
    }
  }

  if (
    !force &&
    defaultAttractRuntime?.roomId === roomId &&
    (defaultAttractRuntime.browsers.some((browser) => browser.exitCode === null) ||
      defaultAttractRuntime.restartTimer ||
      defaultAttractRuntime.lastError)
  ) {
    return;
  }

  defaultAttractLaunch = startDefaultAttractRuntime(roomId).finally(() => {
    defaultAttractLaunch = null;
  });
  await defaultAttractLaunch;
}

async function startDefaultAttractRuntime(roomId: string) {
  stopDefaultAttractRuntime();
  const browserCommand = resolveAttractBrowserCommand();
  if (!browserCommand) {
    defaultAttractRuntime = {
      roomId,
      browsers: [],
      profileDirs: [],
      startedAt: Date.now(),
      stopping: false,
      gameOverAt: null,
      lastError: "No Chrome, Edge, or Chromium executable was found for default attract mode.",
      restartTimer: null
    };
    emitRoomEvent(roomId, "attract-error", { roomId, message: defaultAttractRuntime.lastError });
    return;
  }

  const runtime: DefaultAttractRuntime = {
    roomId,
    browsers: [],
    profileDirs: [],
    startedAt: Date.now(),
    stopping: false,
    gameOverAt: null,
    lastError: null,
    restartTimer: null
  };
  defaultAttractRuntime = runtime;

  for (const playerId of PLAYER_IDS) {
    const profileDir = await mkdtemp(join(tmpdir(), `paperclip-battler-${roomId}-${playerId}-`));
    const playerUrl = `http://127.0.0.1:${BRIDGE_PORT}/rooms/${roomId}/players/${playerId}/${ORIGINAL_ENTRY}?attract=1`;
    const browserArgs = [
      ...browserCommand.args,
      "--headless=new",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      playerUrl
    ];
    const browser = spawn(browserCommand.command, browserArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });

    runtime.browsers.push(browser);
    runtime.profileDirs.push(profileDir);

    browser.stderr?.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) runtime.lastError = message.slice(-500);
    });

    browser.once("error", (error) => {
      runtime.lastError = error instanceof Error ? error.message : "Attract browser failed to start.";
      emitRoomEvent(roomId, "attract-error", { roomId, playerId, message: runtime.lastError });
      void cleanupAttractProfile(profileDir);
      scheduleDefaultAttractRestart(roomId);
    });

    browser.once("exit", () => {
      void cleanupAttractProfile(profileDir);
      if (defaultAttractRuntime === runtime && !runtime.stopping && !runtime.gameOverAt) {
        scheduleDefaultAttractRestart(roomId);
      }
    });
  }

  emitRoomEvent(roomId, "room", { room: serializeRoom(roomId), lobby: "default", attract: serializeDefaultAttractRuntime() });
}

function stopDefaultAttractRuntime(roomId?: string) {
  const runtime = defaultAttractRuntime;
  if (!runtime || (roomId && runtime.roomId !== roomId)) return;

  runtime.stopping = true;
  if (runtime.restartTimer) {
    clearTimeout(runtime.restartTimer);
    runtime.restartTimer = null;
  }
  for (const browser of runtime.browsers) {
    if (browser.exitCode === null) browser.kill();
  }
  if (runtime.browsers.every((browser) => browser.exitCode !== null)) {
    for (const profileDir of runtime.profileDirs) {
      void cleanupAttractProfile(profileDir);
    }
  }
  if (defaultAttractRuntime === runtime) defaultAttractRuntime = null;
}

function scheduleDefaultAttractRestart(roomId: string) {
  if (!DEFAULT_ATTRACT_ENABLED || defaultLobby?.roomId !== roomId) return;
  const runtime = defaultAttractRuntime;
  if (!runtime || runtime.roomId !== roomId || runtime.stopping || runtime.gameOverAt || runtime.restartTimer) return;

  runtime.restartTimer = setTimeout(() => {
    runtime.restartTimer = null;
    void ensureDefaultAttractRuntime(roomId, true);
  }, ATTRACT_BROWSER_RESTART_MS);
}

async function cleanupAttractProfile(profileDir: string) {
  try {
    await rm(profileDir, { recursive: true, force: true });
  } catch {
    // Temporary browser profiles are best-effort cleanup.
  }
}

function resolveAttractBrowserCommand(): BrowserCommand | null {
  const configured = process.env.PAPERCLIP_ATTRACT_BROWSER_PATH?.trim();
  if (configured) return { command: configured, args: parseBrowserArgs(process.env.PAPERCLIP_ATTRACT_BROWSER_ARGS) };

  const candidates = getAttractBrowserCandidates();
  const existing = candidates.find((candidate) => {
    const isPath = candidate.includes("/") || candidate.includes("\\");
    return isPath && existsSync(candidate);
  });
  if (existing) return { command: existing, args: [] };

  const pathCandidates =
    process.platform === "win32"
      ? ["msedge.exe", "chrome.exe"]
      : process.platform === "darwin"
        ? []
        : ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"];
  return pathCandidates.length ? { command: pathCandidates[0], args: [] } : null;
}

function parseBrowserArgs(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
}

function getAttractBrowserCandidates() {
  if (process.platform === "win32") {
    return [
      process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe") : "",
      process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe") : "",
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe") : "",
      process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : "",
      process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : "",
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : ""
    ].filter(Boolean);
  }

  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ];
  }

  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
}

function handleDefaultAttractReport(roomId: string, playerId: PlayerId, report: AgentReport) {
  if (!DEFAULT_ATTRACT_ENABLED || defaultLobby?.roomId !== roomId || defaultAttractRuntime?.roomId !== roomId) return;
  if (defaultAttractRuntime.gameOverAt) return;

  const result = detectGameWinner(report);
  if (!result) return;

  defaultAttractRuntime.gameOverAt = Date.now();
  const nextRoom = rotateDefaultLobby(DEFAULT_ATTRACT_TITLE);
  const payload = {
    winner: playerId,
    winnerLabel: PLAYER_LABELS[playerId],
    message: `${PLAYER_LABELS[playerId]} wins`,
    reason: result.reason,
    nextRoomId: nextRoom.id,
    restartDelayMs: DEFAULT_ATTRACT_RESTART_DELAY_MS
  };
  completeRoom(roomId, payload);
}

function detectGameWinner(report: AgentReport) {
  const text = report.visibleText.toLowerCase();
  const visibleButtonText = report.buttons
    .filter((button) => button.visible)
    .map((button) => `${button.id} ${button.text} ${button.title} ${button.value}`.toLowerCase())
    .join(" ");

  if (/all matter.*converted.*paperclips/.test(text) || /universe.*converted.*paperclips/.test(text)) {
    return { reason: "All matter converted to paperclips." };
  }

  if (/\byou (win|won)\b/.test(text) && /paperclip|universe|matter/.test(text)) {
    return { reason: "Victory text detected." };
  }

  if (/restart/.test(visibleButtonText) && /universe|matter|paperclips/.test(text) && /100(?:\.0+)?%/.test(text)) {
    return { reason: "Endgame restart control detected." };
  }

  return null;
}

function completeRoom(roomId: string, payload: Record<string, unknown> = {}) {
  const room = getRoomState(roomId);
  const now = Date.now();

  if (!room.completedAt) {
    room.completedAt = now;
    room.expiresAt = now + COMPLETED_ROOM_TTL_MS;
  } else if (!room.expiresAt) {
    room.expiresAt = room.completedAt + COMPLETED_ROOM_TTL_MS;
  }

  const expiresAt = room.expiresAt ?? now + COMPLETED_ROOM_TTL_MS;
  room.expiresAt = expiresAt;
  const closeDeadline = getRoomCloseDeadline(room, now);
  const closesAt = closeDeadline?.closesAt ?? expiresAt;
  const eventPayload = {
    ...payload,
    completedAt: room.completedAt,
    expiresAt,
    closesAt,
    ttlMs: Math.max(0, closesAt - now),
    room: serializeRoom(roomId)
  };
  const event = emitRoomEvent(roomId, "game-over", eventPayload);
  return {
    event,
    completedAt: room.completedAt,
    expiresAt
  };
}

function startRoomCleanupTimer() {
  if (roomCleanupTimer) return;
  roomCleanupTimer = setInterval(() => cleanupRooms(), ROOM_CLEANUP_INTERVAL_MS);
}

function cleanupRooms(now = Date.now()) {
  cleanupClosedRoomRecords(now);

  for (const room of Array.from(rooms.values())) {
    if (room.id === DEFAULT_ROOM_ID) continue;

    maybeEmitRoomLifecycleWarnings(room, now);
    const closeReason = getRoomCloseReason(room, now);
    if (closeReason) closeRoom(room, closeReason);
  }
}

function getRoomCloseReason(room: RoomState, now = Date.now()) {
  const deadline = getRoomCloseDeadline(room, now);
  if (!deadline || deadline.closesAt > now) return null;
  return deadline.reason;
}

function getRoomCloseDeadline(room: RoomState, now = Date.now()) {
  if (room.id === DEFAULT_ROOM_ID) return null;

  const deadlines: Array<{ closesAt: number; reason: string; kind: "completed" | RoomWarningKind }> = [];

  if (room.completedAt && room.expiresAt) {
    deadlines.push({ closesAt: room.expiresAt, reason: "Completed lobby expired.", kind: "completed" });
  } else {
    deadlines.push({
      closesAt: getIdleRoomExpiresAt(room),
      reason: "Lobby inactive for too long.",
      kind: "idle"
    });
  }

  deadlines.push({
    closesAt: getMaxRoomAgeExpiresAt(room),
    reason: "Lobby reached the maximum lifetime.",
    kind: "max-age"
  });

  return deadlines.sort((left, right) => left.closesAt - right.closesAt)[0] ?? null;
}

function getIdleRoomExpiresAt(room: RoomState) {
  return room.lastActivityAt + IDLE_ROOM_TTL_MS;
}

function getMaxRoomAgeExpiresAt(room: RoomState) {
  return room.createdAt + MAX_ROOM_AGE_MS;
}

function getRoomWarnings(room: RoomState, now = Date.now()): RoomWarning[] {
  if (room.id === DEFAULT_ROOM_ID) return [];
  if (room.completedAt) return [];

  const warnings: RoomWarning[] = [];
  const idleClosesAt = getIdleRoomExpiresAt(room);
  if (now >= idleClosesAt - IDLE_ROOM_WARNING_MS && now < idleClosesAt) {
    warnings.push(createRoomWarning("idle", idleClosesAt, now));
  }

  const maxAgeClosesAt = getMaxRoomAgeExpiresAt(room);
  if (now >= maxAgeClosesAt - MAX_ROOM_AGE_WARNING_MS && now < maxAgeClosesAt) {
    warnings.push(createRoomWarning("max-age", maxAgeClosesAt, now));
  }

  return warnings;
}

function createRoomWarning(kind: RoomWarningKind, closesAt: number, now = Date.now()): RoomWarning {
  if (kind === "idle") {
    return {
      kind,
      message: "Lobby inactive. Take an action to keep it open.",
      action: "Take any action or press Keep open.",
      issuedAt: now,
      closesAt,
      ttlMs: Math.max(0, closesAt - now)
    };
  }

  return {
    kind,
    message: "Lobby has been open for almost 24 hours and will close soon.",
    action: null,
    issuedAt: now,
    closesAt,
    ttlMs: Math.max(0, closesAt - now)
  };
}

function maybeEmitRoomLifecycleWarnings(room: RoomState, now = Date.now()) {
  for (const warning of getRoomWarnings(room, now)) {
    if (warning.kind === "idle") {
      if (room.idleWarningSentAt && room.idleWarningSentAt >= room.lastActivityAt) continue;
      room.idleWarningSentAt = now;
    } else if (warning.kind === "max-age") {
      if (room.maxAgeWarningSentAt) continue;
      room.maxAgeWarningSentAt = now;
    }

    emitRoomEvent(room.id, "room-warning", { warning, room: serializeRoom(room.id) });
  }
}

function cleanupClosedRoomRecords(now = Date.now()) {
  for (const [roomId, closedRoom] of closedRooms) {
    if (now - closedRoom.closedAt > CLOSED_ROOM_TOMBSTONE_TTL_MS) {
      closedRooms.delete(roomId);
    }
  }
}

function closeRoom(room: RoomState, reason: string) {
  const closedAt = Date.now();
  const nextRoom = defaultLobby?.roomId === room.id ? rotateDefaultLobby(DEFAULT_ATTRACT_TITLE) : null;
  const closedRoom: ClosedRoomRecord = {
    roomId: room.id,
    completedAt: room.completedAt,
    expiresAt: room.expiresAt,
    closedAt,
    reason
  };

  emitRoomEvent(room.id, "room-closed", { ...closedRoom, nextRoomId: nextRoom?.id ?? null });
  for (const client of Array.from(room.sseClients)) {
    try {
      client.end();
    } catch {
      // Closing stale event streams is best effort.
    }
  }
  room.sseClients.clear();
  rooms.delete(room.id);
  closedRooms.set(room.id, closedRoom);
}

function serializeRoom(roomId: string) {
  const room = getRoomState(roomId);
  const now = Date.now();
  const participants = getActiveRoomParticipants(room);
  const playerParticipants = participants.filter((participant) => participant.role === "player");
  const observerParticipants = participants.filter((participant) => participant.role === "observer");
  const closeDeadline = getRoomCloseDeadline(room, now);

  return {
    id: room.id,
    title: room.title,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    lastActivityAt: room.lastActivityAt,
    gameStartedAt: room.gameStartedAt,
    completedAt: room.completedAt,
    expiresAt: room.expiresAt,
    idleExpiresAt: room.id === DEFAULT_ROOM_ID || room.completedAt ? null : getIdleRoomExpiresAt(room),
    maxAgeExpiresAt: room.id === DEFAULT_ROOM_ID ? null : getMaxRoomAgeExpiresAt(room),
    closesAt: closeDeadline?.closesAt ?? null,
    closeReason: closeDeadline?.reason ?? null,
    warnings: getRoomWarnings(room, now),
    ttlMs: closeDeadline ? Math.max(0, closeDeadline.closesAt - now) : null,
    elapsedGameMs: elapsedGameMs(room),
    tinyState: room.tinyState,
    roomUrl: `http://127.0.0.1:${BRIDGE_PORT}/rooms/${room.id}`,
    watchUrl: `http://127.0.0.1:${BRIDGE_PORT}/watch/${room.id}`,
    spectatorCount: observerParticipants.length + room.sseClients.size,
    participantCount: participants.length,
    playerCount: playerParticipants.length,
    observerCount: observerParticipants.length,
    participants: participants.map((participant) => serializeRoomParticipant(participant, false)),
    snapshotCount: PLAYER_IDS.filter((playerId) => Boolean(getPlayerState(roomId, playerId).latestReport)).length,
    slots: Object.fromEntries(
      PLAYER_IDS.map((playerId) => {
        const player = getPlayerMeta(roomId, playerId);
        const report = getPlayerState(roomId, playerId).latestReport;
        return [
          playerId,
          {
            player: playerId,
            label: player.label,
            mode: player.mode,
            ready: player.ready,
            connected: isFreshReport(report),
            lastSeenAt: report?.at ?? null,
            claim: player.claim
          }
        ];
      })
    )
  };
}

function joinRoomParticipant(roomId: string, value: unknown) {
  const room = getRoomState(roomId);
  const now = Date.now();
  cleanupRoomParticipants(room, now);

  const sessionId = normalizeRoomSessionId(value);
  const existing = room.participants.get(sessionId);
  const occupied = new Set(
    getActiveRoomParticipants(room, now)
      .filter((participant) => participant.sessionId !== sessionId && participant.role === "player" && participant.player)
      .map((participant) => participant.player as PlayerId)
  );

  if (existing?.role === "player" && existing.player && !occupied.has(existing.player)) {
    existing.lastSeenAt = now;
    markRoomActivity(roomId, now);
    touchRoom(roomId);
    return existing;
  }

  const openPlayer = PLAYER_IDS.find((playerId) => !occupied.has(playerId)) ?? null;
  const participant: RoomParticipant = {
    sessionId,
    role: openPlayer ? "player" : "observer",
    player: openPlayer,
    joinedAt: existing?.joinedAt ?? now,
    lastSeenAt: now
  };

  room.participants.set(sessionId, participant);
  markRoomActivity(roomId, now);
  touchRoom(roomId);
  emitRoomEvent(roomId, "room", { room: serializeRoom(roomId), participant: serializeRoomParticipant(participant, false) });
  return participant;
}

function heartbeatRoomParticipant(roomId: string, value: unknown) {
  const room = getRoomState(roomId);
  const now = Date.now();
  cleanupRoomParticipants(room, now);

  const sessionId = normalizeRoomSessionId(value);
  const participant = room.participants.get(sessionId);
  if (!participant) return joinRoomParticipant(roomId, sessionId);

  participant.lastSeenAt = now;
  touchRoom(roomId);
  return participant;
}

function leaveRoomParticipant(roomId: string, value: unknown) {
  const room = getRoomState(roomId);
  const sessionId = normalizeRoomSessionId(value);
  if (!room.participants.delete(sessionId)) return;

  markRoomActivity(roomId);
  touchRoom(roomId);
  emitRoomEvent(roomId, "room", { room: serializeRoom(roomId) });
}

function getActiveRoomParticipants(room: RoomState, now = Date.now()) {
  cleanupRoomParticipants(room, now);
  return Array.from(room.participants.values()).filter((participant) => now - participant.lastSeenAt <= ROOM_PARTICIPANT_TTL_MS);
}

function cleanupRoomParticipants(room: RoomState, now = Date.now()) {
  for (const [sessionId, participant] of room.participants) {
    if (now - participant.lastSeenAt > ROOM_PARTICIPANT_TTL_MS) {
      room.participants.delete(sessionId);
    }
  }
}

function serializeRoomParticipant(participant: RoomParticipant, revealSessionId: boolean) {
  return {
    sessionId: revealSessionId ? participant.sessionId : undefined,
    sessionSuffix: participant.sessionId.slice(-8),
    role: participant.role,
    player: participant.player,
    joinedAt: participant.joinedAt,
    lastSeenAt: participant.lastSeenAt,
    ttlMs: Math.max(0, ROOM_PARTICIPANT_TTL_MS - (Date.now() - participant.lastSeenAt))
  };
}

function getRoomExport(roomId: string) {
  const room = getRoomState(roomId);
  return {
    ok: true,
    version: 1,
    exportedAt: Date.now(),
    room: serializeRoom(roomId),
    tinyState: room.tinyState,
    players: Object.fromEntries(
      PLAYER_IDS.map((playerId) => {
        const state = getPlayerState(roomId, playerId);
        return [
          playerId,
          {
            meta: getPlayerMeta(roomId, playerId),
            report: summarizeReport(state.latestReport),
            save: state.latestReport?.save ?? null
          }
        ];
      })
    )
  };
}

function importRoomExport(roomId: string, value: unknown) {
  const room = getRoomState(roomId);
  if (!isRecord(value)) throw new Error("Room import must be a JSON object.");

  const importedRoom = isRecord(value.room) ? value.room : null;
  const importedTitle = typeof importedRoom?.title === "string" ? importedRoom.title : undefined;
  if (importedTitle) room.title = normalizeRoomTitle(importedTitle, roomId);

  const tinyState = isRecord(value.tinyState) ? value.tinyState : isRecord(importedRoom?.tinyState) ? importedRoom.tinyState : null;
  if (tinyState) room.tinyState = tinyState;

  if (isRecord(value.players)) {
    for (const playerId of PLAYER_IDS) {
      const importedPlayer = isRecord(value.players[playerId]) ? value.players[playerId] : null;
      const importedMeta = isRecord(importedPlayer?.meta) ? importedPlayer.meta : importedPlayer;
      const state = getPlayerState(roomId, playerId);
      if (isPlayerMode(importedMeta?.mode)) state.mode = importedMeta.mode;
      if (typeof importedMeta?.ready === "boolean") state.ready = importedMeta.ready;
      if (isRecord(importedPlayer?.report)) state.latestReport = normalizeReport(importedPlayer.report as AgentReport);
    }
    updateGameClock(roomId);
  }

  if (typeof importedRoom?.gameStartedAt === "number" && allPlayersReady(roomId)) {
    room.gameStartedAt = importedRoom.gameStartedAt;
  }

  touchRoom(roomId);
  emitRoomEvent(roomId, "room", { room: serializeRoom(roomId) });
}

function getPlayerBridgeState(roomId: string, playerId: PlayerId) {
  const state = getPlayerState(roomId, playerId);
  const connected = isFreshReport(state.latestReport);
  return {
    ...getPlayerMeta(roomId, playerId),
    connected,
    agentConnected: connected,
    lastReportAt: state.latestReport?.at ?? null,
    buttonCount: state.latestReport?.buttons.filter((button) => button.visible).length ?? 0,
    pendingCommand: state.pendingCommand
      ? {
          id: state.pendingCommand.id,
          type: state.pendingCommand.type
        }
      : null,
    report: summarizeReport(state.latestReport)
  };
}

function getPlayerMeta(roomId: string, playerId: PlayerId) {
  const state = getPlayerState(roomId, playerId);
  return {
    id: playerId,
    label: PLAYER_LABELS[playerId],
    mode: state.mode,
    ready: state.ready,
    agentEnabled: agentCanAct(state.mode),
    heuristicEnabled: heuristicCanAct(state.mode),
    userClicksAllowed: userClicksAllowed(state.mode),
    claim: serializeClaim(getActiveClaim(roomId, playerId), false)
  };
}

function getPlayerModes(roomId: string) {
  return Object.fromEntries(PLAYER_IDS.map((playerId) => [playerId, getPlayerMeta(roomId, playerId)]));
}

function allPlayersReady(roomId: string) {
  return PLAYER_IDS.every((playerId) => getPlayerState(roomId, playerId).ready);
}

function setPlayerReadyState(roomId: string, playerId: PlayerId, ready: boolean) {
  getPlayerState(roomId, playerId).ready = ready;
  updateGameClock(roomId);
}

function setAllPlayersReadyState(roomId: string, ready: boolean) {
  for (const playerId of PLAYER_IDS) {
    getPlayerState(roomId, playerId).ready = ready;
  }
  updateGameClock(roomId);
}

function updateGameClock(roomId: string) {
  const room = getRoomState(roomId);
  const nowAllReady = allPlayersReady(roomId);
  const previousStartedAt = room.gameStartedAt;

  if (nowAllReady && !room.gameStartedAt) {
    room.gameStartedAt = Date.now();
  } else if (!nowAllReady && room.gameStartedAt) {
    room.gameStartedAt = null;
  }

  return room.gameStartedAt !== previousStartedAt;
}

function elapsedGameMs(room: RoomState) {
  return room.gameStartedAt ? Math.max(0, Date.now() - room.gameStartedAt) : 0;
}

function readyGateMessage(roomId: string, playerId: PlayerId) {
  const player = getPlayerState(roomId, playerId);
  const waitingOn = PLAYER_IDS.filter((candidateId) => !getPlayerState(roomId, candidateId).ready);

  if (!player.ready) {
    const others = waitingOn.filter((candidateId) => candidateId !== playerId);
    const suffix = others.length ? ` Then wait for ${formatPlayerList(others)} to be ready.` : "";
    return `You need to be ready before taking actions. Mark ${PLAYER_LABELS[playerId]} ready with set_agent_player_ready or the Ready button.${suffix}`;
  }

  return `Waiting for ${formatPlayerList(waitingOn)} to be ready before actions can run.`;
}

function formatPlayerList(playerIds: PlayerId[]) {
  const labels = playerIds.map((playerId) => PLAYER_LABELS[playerId]);
  if (labels.length === 0) return "both players";
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function summarizeReport(report: AgentReport | null) {
  if (!report) return null;
  return {
    at: report.at,
    url: report.url,
    title: report.title,
    visibleText: report.visibleText,
    buttons: report.buttons,
    controls: report.controls
  };
}

function getPlayerState(roomId: string, playerId: PlayerId) {
  const state = getRoomState(roomId).playerStates.get(playerId);
  if (!state) throw new Error(`Unknown player: ${playerId}.`);
  return state;
}

function getActiveClaim(roomId: string, playerId: PlayerId) {
  const state = getPlayerState(roomId, playerId);
  clearExpiredClaim(state);
  return state.claim;
}

function maybeEnsurePlayerClaim(
  roomId: string,
  playerId: PlayerId,
  options: {
    claimToken?: string;
    controller?: string;
    source: PlayerClaim["source"];
  }
) {
  const state = getPlayerState(roomId, playerId);
  if (!agentCanAct(state.mode) || !isFreshReport(state.latestReport)) return null;
  return ensurePlayerClaim(roomId, playerId, options);
}

function ensurePlayerClaim(
  roomId: string,
  playerId: PlayerId,
  {
    claimToken,
    controller,
    source
  }: {
    claimToken?: string;
    controller?: string;
    source: PlayerClaim["source"];
  }
) {
  const state = getPlayerState(roomId, playerId);
  if (!agentCanAct(state.mode)) {
    throw new Error(`${PLAYER_LABELS[playerId]} is not MCP-controlled. Set it to Agent or Both before using MCP commands.`);
  }

  clearExpiredClaim(state);

  if (!state.claim) {
    state.claim = createPlayerClaim(controller, source);
    return state.claim;
  }

  if (claimToken && claimToken === state.claim.token) {
    touchPlayerClaim(state.claim);
    return state.claim;
  }

  const owner = state.claim.label || "another controller";
  throw new Error(
    `${PLAYER_LABELS[playerId]} is already claimed by ${owner}. Use the matching claimToken or release the claim in the UI.`
  );
}

function releasePlayerClaim(roomId: string, playerId: PlayerId, claimToken?: string, force = false) {
  const state = getPlayerState(roomId, playerId);
  clearExpiredClaim(state);
  if (!state.claim) return;
  if (!force && (!claimToken || claimToken !== state.claim.token)) {
    throw new Error(`Cannot release ${PLAYER_LABELS[playerId]} without the matching claimToken.`);
  }
  state.claim = null;
}

function assertReadyChangeAllowed(roomId: string, playerId: PlayerId, claimToken?: string, force = false) {
  const state = getPlayerState(roomId, playerId);
  clearExpiredClaim(state);
  if (!state.claim || force) return;
  if (claimToken === state.claim.token) {
    touchPlayerClaim(state.claim);
    return;
  }
  throw new Error(`Cannot change ${PLAYER_LABELS[playerId]} ready state without the matching claimToken.`);
}

function assertActionReady(roomId: string, playerId: PlayerId) {
  if (!allPlayersReady(roomId)) {
    throw new Error(readyGateMessage(roomId, playerId));
  }
}

function createPlayerClaim(controller: string | undefined, source: PlayerClaim["source"]): PlayerClaim {
  const now = Date.now();
  return {
    token: randomUUID(),
    label: normalizeClaimLabel(controller, source),
    source,
    claimedAt: now,
    lastSeenAt: now,
    expiresAt: now + CLAIM_TTL_MS
  };
}

function touchPlayerClaim(claim: PlayerClaim) {
  const now = Date.now();
  claim.lastSeenAt = now;
  claim.expiresAt = now + CLAIM_TTL_MS;
}

function clearExpiredClaim(state: PlayerState) {
  if (state.claim && state.claim.expiresAt <= Date.now()) {
    state.claim = null;
  }
}

function normalizeClaimLabel(controller: string | undefined, source: PlayerClaim["source"]) {
  const label = controller?.trim().replace(/\s+/g, " ");
  if (label) return label.slice(0, 60);
  return source === "mcp" ? "MCP controller" : "HTTP controller";
}

function serializeClaim(claim: PlayerClaim | null, revealToken: boolean) {
  if (!claim) return null;
  const now = Date.now();
  return {
    token: revealToken ? claim.token : undefined,
    tokenSuffix: claim.token.slice(-8),
    label: claim.label,
    source: claim.source,
    claimedAt: claim.claimedAt,
    lastSeenAt: claim.lastSeenAt,
    expiresAt: claim.expiresAt,
    ttlMs: Math.max(0, claim.expiresAt - now)
  };
}

function isFreshReport(report: AgentReport | null) {
  return Boolean(report && Date.now() - report.at <= REPORT_STALE_MS);
}

function getFreshReport(roomId: string, playerId: PlayerId) {
  const state = getPlayerState(roomId, playerId);
  if (!isFreshReport(state.latestReport)) {
    throw new Error(
      `No live ${PLAYER_LABELS[playerId]} pane is connected in room ${roomId}. Open the app and keep that pane loaded.`
    );
  }
  return state.latestReport as AgentReport;
}

function resolveButton(
  roomId: string,
  playerId: PlayerId,
  {
    buttonId,
    index,
    text
  }: {
  buttonId?: string;
  index?: number;
  text?: string;
  }
) {
  const report = getFreshReport(roomId, playerId);
  const available = report.buttons.filter((button) => button.visible);
  const normalizedText = text?.trim().toLowerCase();

  const button =
    (buttonId ? available.find((candidate) => candidate.id === buttonId) : undefined) ??
    (typeof index === "number" ? available.find((candidate) => candidate.index === index) : undefined) ??
    (normalizedText
      ? available.find(
          (candidate) =>
            candidate.text.toLowerCase() === normalizedText ||
            candidate.text.toLowerCase().includes(normalizedText)
        )
      : undefined);

  if (!button) {
    throw new Error(`Could not find that button in the live ${PLAYER_LABELS[playerId]} pane.`);
  }

  return button;
}

function resolveControl(
  roomId: string,
  playerId: PlayerId,
  {
    controlId,
    index,
    label
  }: {
  controlId?: string;
  index?: number;
  label?: string;
  }
) {
  const report = getFreshReport(roomId, playerId);
  const available = report.controls.filter((control) => control.visible);
  const normalizedLabel = label?.trim().toLowerCase();

  const control =
    (controlId ? available.find((candidate) => candidate.id === controlId) : undefined) ??
    (typeof index === "number" ? available.find((candidate) => candidate.index === index) : undefined) ??
    (normalizedLabel
      ? available.find(
          (candidate) =>
            candidate.label.toLowerCase() === normalizedLabel ||
            candidate.label.toLowerCase().includes(normalizedLabel) ||
            (candidate.elementId ?? "").toLowerCase().includes(normalizedLabel)
        )
      : undefined);

  if (!control) {
    throw new Error(`Could not find that control in the live ${PLAYER_LABELS[playerId]} pane.`);
  }

  return control;
}

function queueCommand(roomId: string, playerId: PlayerId, command: AgentCommand): Promise<AgentCommandResult> {
  const state = getPlayerState(roomId, playerId);

  if (!agentCanAct(state.mode)) {
    throw new Error(`${PLAYER_LABELS[playerId]} is not MCP-controlled. Set it to Agent or Both before using MCP commands.`);
  }

  if (command.type !== "reset" && command.type !== "import-save" && !allPlayersReady(roomId)) {
    assertActionReady(roomId, playerId);
  }

  if (state.pendingCommand) {
    throw new Error(`Another ${PLAYER_LABELS[playerId]} command is already pending.`);
  }

  assertCommandRateLimit(roomId, playerId, command.type);
  state.pendingCommand = command;
  markRoomActivity(roomId);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      commandWaiters.delete(command.id);
      if (state.pendingCommand?.id === command.id) {
        state.pendingCommand = null;
      }
      reject(new Error(`Timed out waiting for the ${PLAYER_LABELS[playerId]} pane to run the command.`));
    }, COMMAND_TIMEOUT_MS);

    commandWaiters.set(command.id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function completeCommand(result: AgentCommandResult) {
  const normalized = {
    ...result,
    at: typeof result.at === "number" ? result.at : Date.now()
  };
  const waiter = commandWaiters.get(normalized.id);
  if (waiter) {
    commandWaiters.delete(normalized.id);
    waiter(normalized);
  }
}

function normalizeReport(report: AgentReport): AgentReport {
  const save = report.save ? sanitizeReportedBrowserSave(normalizeBrowserSave(report.save)) : undefined;

  return {
    at: Date.now(),
    lastUserActivityAt:
      typeof report.lastUserActivityAt === "number" && Number.isFinite(report.lastUserActivityAt)
        ? report.lastUserActivityAt
        : undefined,
    url: String(report.url ?? ""),
    title: String(report.title ?? ""),
    buttons: Array.isArray(report.buttons) ? report.buttons : [],
    controls: Array.isArray(report.controls) ? report.controls : [],
    visibleText: String(report.visibleText ?? "").slice(0, 10_000),
    save
  };
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

function applyGatewayRateLimit(request: IncomingMessage, response: ServerResponse, url: URL) {
  const target = getGatewayRateLimitTarget(request, url);
  if (!target) return true;

  const result = consumeRateLimit(target.policy, target.keyParts);
  if (result.allowed) return true;

  sendRateLimit(response, result);
  return false;
}

function getGatewayRateLimitTarget(request: IncomingMessage, url: URL): RateLimitTarget | null {
  const method = request.method ?? "GET";
  if (method === "OPTIONS") return null;

  const roomPath = safeParseRoomPath(url.pathname);
  const roomId = roomPath?.roomId ?? safeResolveUrlRoomId(url);
  const playerId = safeResolvePlayerId(url, roomPath);
  const clientKey = getClientKey(request);
  const routeKey = getGatewayRouteKey(url, roomPath);

  if (method === "POST" && url.pathname === "/command/click") {
    return null;
  }

  if (isPlayerControlPath(url.pathname)) {
    return {
      policy: RATE_LIMITS.playerControl,
      keyParts: [roomId, playerId, clientKey, routeKey]
    };
  }

  if (isAssetProxyPath(url.pathname, roomPath)) {
    // Browser navigations and subresources do not have a separate error channel.
    // Keep limiter responses on command/control APIs so iframe documents are not replaced by 429 JSON.
    return null;
  }

  if (roomPath?.kind === "rooms" && roomPath.rest === "/events") {
    return {
      policy: method === "GET" ? RATE_LIMITS.eventStream : RATE_LIMITS.bridgeWrite,
      keyParts: [roomId, clientKey, method]
    };
  }

  if (isBulkRoomWrite(method, roomPath)) {
    return {
      policy: RATE_LIMITS.bridgeBulkWrite,
      keyParts: [roomId, clientKey, routeKey]
    };
  }

  if (method === "POST") {
    return {
      policy: RATE_LIMITS.bridgeWrite,
      keyParts: [roomId, clientKey, routeKey]
    };
  }

  if (method === "GET" || method === "HEAD") {
    return {
      policy: RATE_LIMITS.bridgeRead,
      keyParts: [roomId, clientKey, routeKey]
    };
  }

  return {
    policy: RATE_LIMITS.fallback,
    keyParts: [clientKey, method, routeKey]
  };
}

function assertCommandRateLimit(roomId: string, playerId: PlayerId, commandType: AgentCommand["type"]) {
  const target =
    commandType === "click"
      ? { policy: RATE_LIMITS.paperclipClick, keyParts: [roomId] }
      : { policy: RATE_LIMITS.bridgeCommand, keyParts: [roomId, playerId, commandType] };
  const result = consumeRateLimit(target.policy, target.keyParts);
  if (!result.allowed) throw new RateLimitError(result);
}

function consumeRateLimit(policy: RateLimitPolicy, keyParts: Array<string | number | undefined>): RateLimitResult {
  const now = Date.now();
  cleanupRateLimitBuckets(now);

  const key = [policy.name, ...keyParts.map(formatRateLimitKeyPart)].join(":");
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + policy.windowMs });
    return { allowed: true, retryAfterMs: 0, message: policy.message };
  }

  if (bucket.count >= policy.max) {
    return {
      allowed: false,
      retryAfterMs: Math.max(1, bucket.resetAt - now),
      message: policy.message
    };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterMs: bucket.resetAt - now, message: policy.message };
}

function cleanupRateLimitBuckets(now: number) {
  if (now - lastRateLimitCleanupAt < RATE_LIMIT_CLEANUP_INTERVAL_MS) return;
  lastRateLimitCleanupAt = now;

  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
}

function formatRateLimitKeyPart(value: string | number | undefined) {
  return encodeURIComponent(String(value ?? "default"));
}

function sendRateLimitError(response: ServerResponse, error: RateLimitError) {
  sendRateLimit(response, {
    allowed: false,
    retryAfterMs: error.retryAfterMs,
    message: error.message
  });
}

function sendRateLimit(response: ServerResponse, result: RateLimitResult) {
  sendJson(
    response,
    429,
    {
      ok: false,
      message: result.message
    },
    {
      "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)))
    }
  );
}

function getClientKey(request: IncomingMessage) {
  const forwardedFor = request.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const forwardedClient = forwardedValue?.split(",")[0]?.trim();
  return forwardedClient || request.socket.remoteAddress || "local";
}

function getGatewayRouteKey(url: URL, roomPath: ReturnType<typeof parseRoomPath> | null) {
  if (!roomPath) return url.pathname;
  return `/${roomPath.kind}/:room${roomPath.rest.replace(/^\/players\/[^/]+/, "/players/:player")}`;
}

function safeParseRoomPath(pathname: string) {
  try {
    return parseRoomPath(pathname);
  } catch {
    return null;
  }
}

function safeResolveUrlRoomId(url: URL) {
  try {
    return resolveUrlRoomId(url);
  } catch {
    return DEFAULT_ROOM_ID;
  }
}

function safeResolvePlayerId(url: URL, roomPath: ReturnType<typeof parseRoomPath> | null) {
  const path = roomPath?.rest ?? url.pathname;
  const pathMatch = path.match(/^\/players\/([^/]+)/);
  const rawPlayer = url.searchParams.get("player") ?? pathMatch?.[1] ?? (path.startsWith("/agent/") ? "right" : undefined);

  try {
    return normalizePlayerId(rawPlayer);
  } catch {
    return "right";
  }
}

function isPlayerControlPath(pathname: string) {
  return (
    pathname === "/player-control/config" ||
    pathname === "/agent-control/config" ||
    pathname === "/player-control/report" ||
    pathname === "/agent-control/report" ||
    pathname === "/player-control/heuristic-ticks" ||
    pathname === "/agent-control/heuristic-ticks" ||
    pathname === "/player-control/next-command" ||
    pathname === "/agent-control/next-command" ||
    pathname === "/player-control/result" ||
    pathname === "/agent-control/result"
  );
}

function isAssetProxyPath(pathname: string, roomPath: ReturnType<typeof parseRoomPath> | null) {
  const path = roomPath?.rest ?? pathname;
  return path.startsWith("/players/") || path.startsWith("/agent/");
}

function isBulkRoomWrite(method: string, roomPath: ReturnType<typeof parseRoomPath> | null) {
  return (
    method === "POST" &&
    roomPath?.kind === "rooms" &&
    (roomPath.rest === "/import" || roomPath.rest === "/save/import")
  );
}

function setCors(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BODY_SIZE) {
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

function inferContentType(path: string) {
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function parseRoomPath(pathname: string) {
  const match = pathname.match(/^\/(rooms|watch)\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  return {
    kind: match[1] as "rooms" | "watch",
    roomId: normalizeRoomId(match[2]),
    rest: match[3] ? `/${match[3]}` : "/"
  };
}

function resolveUrlRoomId(url: URL) {
  return normalizeRoomId(url.searchParams.get("room") ?? DEFAULT_ROOM_ID);
}

function resolveBodyRoomId(url: URL, body: { room?: unknown }) {
  return normalizeRoomId(body.room ?? url.searchParams.get("room") ?? DEFAULT_ROOM_ID);
}

function normalizeRoomId(value: unknown) {
  const normalized = String(value ?? DEFAULT_ROOM_ID)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (!normalized) return DEFAULT_ROOM_ID;
  if (normalized.length > 32) throw new Error("Room id must be 32 characters or fewer.");
  return normalized;
}

function normalizeRoomSessionId(value: unknown) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 96);
  return normalized.length >= 8 ? normalized : randomUUID();
}

function createShortRoomId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const roomId = randomUUID().replace(/-/g, "").slice(0, ROOM_ID_LENGTH);
    if (!rooms.has(roomId) && !closedRooms.has(roomId)) return roomId;
  }
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function normalizeRoomTitle(title: unknown, roomId: string) {
  const value = typeof title === "string" ? title.trim().replace(/\s+/g, " ") : "";
  return value ? value.slice(0, 80) : roomId === DEFAULT_ROOM_ID ? "Local Room" : `Room ${roomId}`;
}

function normalizeEventType(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-") : "";
  return normalized || "message";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPlayerMode(value: unknown): value is PlayerMode {
  return typeof value === "string" && PLAYER_MODES.includes(value as PlayerMode);
}

function normalizeBrowserSave(value: unknown): PlayerBrowserSave {
  const source = isRecord(value) ? value : {};
  return {
    localStorage: normalizeStringRecord(source.localStorage),
    sessionStorage: normalizeStringRecord(source.sessionStorage)
  };
}

function sanitizeReportedBrowserSave(save: PlayerBrowserSave): PlayerBrowserSave {
  return {
    localStorage: stripInternalStorageKeys(save.localStorage),
    sessionStorage: stripInternalStorageKeys(save.sessionStorage)
  };
}

function stripInternalStorageKeys(record: Record<string, string>) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !isInternalStorageKey(key)));
}

function isInternalStorageKey(key: string) {
  return key.startsWith("watch:") || key.startsWith("paperclip-battler:");
}

function normalizeStringRecord(value: unknown) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function subscribeHeuristicTicks(roomId: string, playerId: PlayerId, request: IncomingMessage, response: ServerResponse) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  let closed = false;
  let lastDecisionAt = 0;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (tickTimer) clearInterval(tickTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  function writeEvent(type: string, payload: Record<string, unknown> = {}) {
    if (closed) return;

    try {
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({
          roomId,
          playerId,
          at: Date.now(),
          ...payload
        })}\n\n`
      );
    } catch {
      cleanup();
    }
  }

  function writeHeartbeat() {
    if (closed) return;

    try {
      response.write(`: heuristic ${Date.now()}\n\n`);
    } catch {
      cleanup();
    }
  }

  function tick() {
    const state = getPlayerState(roomId, playerId);
    const everyoneReady = allPlayersReady(roomId);
    if (!heuristicCanAct(state.mode) || !everyoneReady) return;

    const payload = {
      mode: state.mode,
      playerReady: state.ready,
      allPlayersReady: everyoneReady
    };
    const now = Date.now();

    writeEvent("manual-paperclip", payload);
    if (now - lastDecisionAt >= BRIDGE_HEURISTIC_DECISION_TICK_MS) {
      lastDecisionAt = now;
      writeEvent("decision", payload);
    }
  }

  writeHeartbeat();
  tickTimer = setInterval(tick, BRIDGE_HEURISTIC_MANUAL_CLIP_TICK_MS);
  heartbeatTimer = setInterval(writeHeartbeat, BRIDGE_HEURISTIC_TICK_HEARTBEAT_MS);

  request.on("close", cleanup);
}

function subscribeRoomEvents(roomId: string, request: IncomingMessage, response: ServerResponse) {
  const room = getRoomState(roomId);
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  response.write(`event: snapshot\ndata: ${JSON.stringify({ room: serializeRoom(roomId), state: getBridgeState(roomId) })}\n\n`);
  room.sseClients.add(response);
  touchRoom(roomId);
  request.on("close", () => {
    room.sseClients.delete(response);
    touchRoom(roomId);
  });
}

function emitRoomEvent(roomId: string, type: string, payload: unknown) {
  const room = getRoomState(roomId);
  const event: RoomEvent = {
    id: room.nextEventId,
    roomId,
    type,
    at: Date.now(),
    payload
  };
  room.nextEventId += 1;
  room.updatedAt = event.at;

  const message = `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of Array.from(room.sseClients)) {
    try {
      client.write(message);
    } catch {
      room.sseClients.delete(client);
    }
  }
  return event;
}

function normalizeInstructionMode(value: unknown): InstructionMode {
  return typeof value === "string" && INSTRUCTION_MODES.includes(value as InstructionMode)
    ? (value as InstructionMode)
    : "none";
}

function normalizePlayerId(value: unknown): PlayerId {
  const normalized = String(value ?? "right").trim().toLowerCase();
  if (normalized === "left" || normalized === "player" || normalized === "p1" || normalized === "1") return "left";
  if (normalized === "right" || normalized === "agent" || normalized === "p2" || normalized === "2") return "right";
  throw new Error("Player must be left/player/1 or right/agent/2.");
}

function normalizePlayerMode(value: unknown): PlayerMode {
  if (typeof value === "string" && PLAYER_MODES.includes(value as PlayerMode)) {
    return value as PlayerMode;
  }
  throw new Error("Player mode must be human, agent, heuristic, or both.");
}

function agentCanAct(mode: PlayerMode) {
  return mode === "agent" || mode === "both";
}

function heuristicCanAct(mode: PlayerMode) {
  return mode === "heuristic";
}

function userClicksAllowed(mode: PlayerMode) {
  return mode === "human" || mode === "both";
}

function instructionModeLabel(mode: InstructionMode) {
  if (mode === "paul") return "Paul";
  if (mode === "codex") return "Codex";
  return "None";
}

function getPaulsAgentInstructions() {
  return readInstructionFile(PAULS_INSTRUCTION_PATHS, [
    "# Paul's Agent AI Instructions",
    "",
    "Play only an Agent or Both pane. Claim the target player, preserve the claim token, act through",
    "the exposed buttons and controls after both players are ready, report compact status updates, and never reset unless Paul asks."
  ]);
}

function getCodexAgentInstructions() {
  return readInstructionFile(CODEX_INSTRUCTION_PATHS, [
    "# Codex Agent AI Instructions",
    "",
    "Use this optional self-playbook when it helps. Claim a target player, observe the live state, act in",
    "short verified bursts after both players are ready, improve the bridge when controls are missing, and update the playbook when tactics change."
  ]);
}

function readInstructionFile(paths: string[], fallbackLines: string[]) {
  const instructionPath = paths.find((path) => existsSync(path));
  return instructionPath ? readFileSync(instructionPath, "utf8") : fallbackLines.join("\n");
}

const AGENT_CONTROLLER_SCRIPT = String.raw`
(() => {
  const ROOM_ID = __PAPERCLIP_ROOM_ID__;
  const PLAYER_ID = __PAPERCLIP_PLAYER_ID__;
  const ROOM_QUERY = "room=" + encodeURIComponent(ROOM_ID) + "&player=" + encodeURIComponent(PLAYER_ID);
  const CONFIG_URL = "/player-control/config?" + ROOM_QUERY;
  const REPORT_URL = "/player-control/report?" + ROOM_QUERY;
  const COMMAND_URL = "/player-control/next-command?" + ROOM_QUERY;
  const RESULT_URL = "/player-control/result?" + ROOM_QUERY;
  const HEURISTIC_TICK_URL = "/player-control/heuristic-ticks?" + ROOM_QUERY;
  const INTERACTIVE_SELECTOR =
    'button,input:not([type="hidden"]),select,textarea,a[onclick],[role="button"]';
  const SHIELD_EVENTS = [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "touchstart",
    "touchend"
  ];
  const HEURISTIC_DECISION_TICK_MS = 750;
  const HEURISTIC_MANUAL_CLIP_TICK_MS = 125;
  const HEURISTIC_BRIDGE_TICK_STALE_MS = 2000;
  const REPORT_MIN_INTERVAL_MS = 500;
  const HEURISTIC_PRICE_COOLDOWN_MS = 3000;
  const HEURISTIC_WIRE_BUY_COOLDOWN_MS = 750;
  const HEURISTIC_WIRE_STALL_BELOW = 1;
  const HEURISTIC_WIRE_SAVE_BELOW = 500;
  const HEURISTIC_AVERAGE_WIRE_COST = 20;
  const HEURISTIC_LOW_DEMAND = 5;
  const HEURISTIC_HEALTHY_DEMAND = 20;
  const HEURISTIC_MIN_PRICE = 0.01;
  const HEURISTIC_PROBE_TARGETS = {
    Speed: 1,
    Nav: 1,
    Rep: 7,
    Haz: 5,
    Fac: 1,
    Harv: 2,
    Wire: 2,
    Combat: 0
  };
  const HEURISTIC_PROBE_TARGET_ORDER = ["Rep", "Haz", "Nav", "Speed", "Fac", "Harv", "Wire", "Combat"];
  const HEURISTIC_WIRE_LOW_PRICE_RULES = [
    { maxCost: 10, targetWire: 10000 },
    { maxCost: 12, targetWire: 5000 },
    { maxCost: 14, targetWire: 2000 }
  ];
  const HEURISTIC_SKIP_PATTERN = /reset|restart|import|export|load|save|price|deposit|withdraw|investment/i;
  const HEURISTIC_BUTTON_RULES = [
    { pattern: /project|hypno|probe|drone|factory|harvester|tournament|strategy/i, score: 90, cooldownMs: 1800 },
    { pattern: /processor|memory|operations|op|compute|quantum/i, score: 82, cooldownMs: 1200 },
    { pattern: /clipper|auto\s*clipper|mega\s*clipper/i, score: 78, cooldownMs: 900 },
    { pattern: /marketing|demand/i, score: 64, cooldownMs: 2200 },
    { pattern: /paperclip|clip/i, score: 12, cooldownMs: 1400 }
  ];

  let playerMode = "human";
  let playerReady = false;
  let allPlayersReady = false;
  let inputShield = null;
  let inputTooltip = null;
  let reportTimer = null;
  let configInFlight = false;
  let reportInFlight = false;
  let reportAgainAfterInFlight = false;
  let pollInFlight = false;
  let lastReportAt = 0;
  let lastUserActivityAt = 0;
  let lastBridgeHeuristicTickAt = 0;
  let suppressClickReportUntil = 0;
  let heuristicTickStream = null;
  const heuristicCooldowns = new Map();

  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const agentCanAct = () => playerMode === "agent" || playerMode === "both";
  const heuristicCanAct = () => playerMode === "heuristic";
  const userInputLocked = () => !allPlayersReady || playerMode === "agent" || playerMode === "heuristic";
  const inputLockMessage = () => {
    if (!allPlayersReady) return "Both players must be ready first.";
    if (playerMode === "heuristic") return "Mouse input is locked while heuristic AI is running.";
    return "Mouse input is locked while this player is Agent-only.";
  };

  const installStyles = () => {
    const style = document.createElement("style");
    style.textContent = [
      'html[data-paperclip-battler-input-locked="true"],',
      'html[data-paperclip-battler-input-locked="true"] body {',
      "cursor: not-allowed !important;",
      "}",
      "#paperclip-battler-input-shield {",
      "position: fixed !important;",
      "inset: 0 !important;",
      "z-index: 2147483647 !important;",
      "display: none !important;",
      "cursor: not-allowed !important;",
      "background: rgba(255, 255, 255, 0) !important;",
      "pointer-events: none !important;",
      "touch-action: none !important;",
      "}",
      "#paperclip-battler-input-tooltip {",
      "all: initial !important;",
      "display: block !important;",
      "box-sizing: border-box !important;",
      "position: fixed !important;",
      "left: 16px !important;",
      "top: 16px !important;",
      "z-index: 2147483647 !important;",
      "max-width: min(280px, calc(100vw - 32px)) !important;",
      "padding: 7px 9px !important;",
      "border-radius: 6px !important;",
      "background: rgba(17, 24, 39, 0.94) !important;",
      "color: #ffffff !important;",
      "font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;",
      "box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22) !important;",
      "opacity: 0 !important;",
      "pointer-events: none !important;",
      "white-space: normal !important;",
      "transition: opacity 120ms ease !important;",
      "}",
      '#paperclip-battler-input-tooltip[data-visible="true"] {',
      "opacity: 1 !important;",
      "}",
      'html[data-paperclip-battler-input-locked="true"] #paperclip-battler-input-shield {',
      "display: block !important;",
      "pointer-events: auto !important;",
      "}",
      'html[data-paperclip-battler-input-locked="true"] button:not(:disabled),',
      'html[data-paperclip-battler-input-locked="true"] input:not([type="hidden"]):not(:disabled),',
      'html[data-paperclip-battler-input-locked="true"] select:not(:disabled),',
      'html[data-paperclip-battler-input-locked="true"] textarea:not(:disabled),',
      'html[data-paperclip-battler-input-locked="true"] a[onclick],',
      'html[data-paperclip-battler-input-locked="true"] [role="button"] {',
      "cursor: not-allowed !important;",
      "pointer-events: none !important;",
      "}",
      'html[data-paperclip-battler-input-locked="true"] [data-paperclip-battler-user-locked="true"]:hover {',
      "outline: 1px dashed #9b6a16 !important;",
      "outline-offset: 2px !important;",
      "}",
      ".paperclip-battler-mcp-press {",
      "transform: translateY(1px) scale(0.98) !important;",
      "filter: brightness(0.92) saturate(1.2) !important;",
      "outline: 2px solid #2f74d0 !important;",
      "outline-offset: 1px !important;",
      "transition: transform 90ms ease, filter 90ms ease !important;",
      "}",
      ".paperclip-battler-input-blocked {",
      "animation: paperclip-battler-blocked 180ms ease-out;",
      "}",
      "@keyframes paperclip-battler-blocked {",
      "0%, 100% { filter: none; }",
      "35% { filter: sepia(0.5) saturate(1.4) brightness(1.05); }",
      "}"
    ].join("");
    document.head.appendChild(style);
  };

  const ensureInputShield = () => {
    if (inputShield?.isConnected) return inputShield;
    inputShield = document.createElement("div");
    inputShield.id = "paperclip-battler-input-shield";
    inputShield.setAttribute("aria-hidden", "true");
    inputShield.title = inputLockMessage();
    for (const eventName of SHIELD_EVENTS) {
      inputShield.addEventListener(eventName, blockShieldInput, true);
    }
    inputShield.addEventListener("pointerenter", showInputTooltip, true);
    inputShield.addEventListener("pointermove", showInputTooltip, true);
    inputShield.addEventListener("pointerleave", hideInputTooltip, true);
    document.body.appendChild(inputShield);
    ensureInputTooltip();
    return inputShield;
  };

  const ensureInputTooltip = () => {
    if (inputTooltip?.isConnected) return inputTooltip;
    const shield = inputShield?.isConnected ? inputShield : null;
    if (!shield) return null;
    inputTooltip = document.createElement("div");
    inputTooltip.id = "paperclip-battler-input-tooltip";
    inputTooltip.setAttribute("role", "status");
    inputTooltip.textContent = inputLockMessage();
    shield.appendChild(inputTooltip);
    return inputTooltip;
  };

  const positionInputTooltip = (event) => {
    const tooltip = ensureInputTooltip();
    if (!tooltip || typeof event?.clientX !== "number" || typeof event?.clientY !== "number") return;
    const margin = 12;
    const offset = 14;
    tooltip.style.maxWidth = Math.max(160, Math.min(280, window.innerWidth - margin * 2)) + "px";
    tooltip.textContent = inputLockMessage();

    let left = event.clientX + offset;
    let top = event.clientY + offset;
    const rect = tooltip.getBoundingClientRect();

    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, event.clientX - rect.width - offset);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, event.clientY - rect.height - offset);
    }

    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  };

  const showInputTooltip = (event) => {
    if (!userInputLocked()) return hideInputTooltip();
    const tooltip = ensureInputTooltip();
    if (!tooltip) return;
    tooltip.textContent = inputLockMessage();
    tooltip.dataset.visible = "true";
    positionInputTooltip(event);
  };

  const hideInputTooltip = () => {
    if (inputTooltip) delete inputTooltip.dataset.visible;
  };

  const elementSelector = (element, fallbackIndex) => {
    if (element.id) return "#" + cssEscape(element.id);
    const path = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.body) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === node.tagName);
      const position = Math.max(1, siblings.indexOf(node) + 1);
      path.unshift(tag + ":nth-of-type(" + position + ")");
      node = parent;
    }
    return path.length ? path.join(" > ") : "button:nth-of-type(" + (fallbackIndex + 1) + ")";
  };

  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const buttonText = (element) =>
    normalizeText(
      element.innerText ||
        element.value ||
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.id ||
        element.name
    );

  const buttonElements = () =>
    Array.from(
      document.querySelectorAll(
        'button,input[type="button"],input[type="submit"],input[type="reset"],a[onclick],[role="button"]'
      )
    );

  const controlElements = () =>
    Array.from(
      document.querySelectorAll(
        'input:not([type="button"]):not([type="submit"]):not([type="reset"]),select,textarea'
      )
    );

  const setPlayerMode = (mode) => {
    playerMode = mode === "agent" || mode === "both" || mode === "heuristic" ? mode : "human";
    document.documentElement.dataset.paperclipBattlerMode = playerMode;
    applyInputLock();
  };

  const setReadyState = (ready, everyoneReady) => {
    playerReady = Boolean(ready);
    allPlayersReady = Boolean(everyoneReady);
    document.documentElement.dataset.paperclipBattlerReady = String(playerReady);
    document.documentElement.dataset.paperclipBattlerAllReady = String(allPlayersReady);
    applyInputLock();
  };

  const applyInputLock = () => {
    const locked = userInputLocked();
    document.documentElement.dataset.paperclipBattlerInputLocked = String(locked);
    if (document.body) {
      const shield = ensureInputShield();
      const message = inputLockMessage();
      shield.title = message;
      const tooltip = ensureInputTooltip();
      if (tooltip) tooltip.textContent = message;
      if (!locked) hideInputTooltip();
    }
    for (const element of [...buttonElements(), ...controlElements()]) {
      if (locked) {
        element.setAttribute("data-paperclip-battler-user-locked", "true");
        element.setAttribute("aria-disabled", "true");
      } else {
        element.removeAttribute("data-paperclip-battler-user-locked");
        element.removeAttribute("aria-disabled");
      }
    }
  };

  const refreshConfig = async () => {
    if (configInFlight) return;
    configInFlight = true;
    try {
      const response = await fetch(CONFIG_URL, { cache: "no-store" });
      if (!response.ok) throw new Error("config failed");
      const payload = await response.json();
      setPlayerMode(payload?.player?.mode);
      setReadyState(payload?.player?.ready, payload?.allPlayersReady);
    } catch {
      // The bridge may be restarting.
    } finally {
      configInFlight = false;
    }
  };

  const bridgeHeuristicTicksFresh = () => Date.now() - lastBridgeHeuristicTickAt < HEURISTIC_BRIDGE_TICK_STALE_MS;

  const applyBridgeHeuristicTick = (event) => {
    lastBridgeHeuristicTickAt = Date.now();

    try {
      const payload = JSON.parse(event.data || "{}");
      if (payload?.mode) setPlayerMode(payload.mode);
      if (typeof payload?.allPlayersReady === "boolean") setReadyState(payload.playerReady, payload.allPlayersReady);
    } catch {
      // Keep heuristic input moving even if a transient bridge event is malformed.
    }
  };

  const startHeuristicTickStream = () => {
    if (!window.EventSource || heuristicTickStream) return;

    heuristicTickStream = new EventSource(HEURISTIC_TICK_URL);
    heuristicTickStream.addEventListener("manual-paperclip", (event) => {
      applyBridgeHeuristicTick(event);
      runManualPaperclipTick();
    });
    heuristicTickStream.addEventListener("decision", (event) => {
      applyBridgeHeuristicTick(event);
      runHeuristicTick();
    });
    heuristicTickStream.onerror = () => {
      if (heuristicTickStream?.readyState === EventSource.CLOSED) heuristicTickStream = null;
    };
  };

  const closestInteractive = (target) =>
    target instanceof Element ? target.closest(INTERACTIVE_SELECTOR) : null;

  const flashBlocked = (element) => {
    element.classList.remove("paperclip-battler-input-blocked");
    void element.offsetWidth;
    element.classList.add("paperclip-battler-input-blocked");
    window.setTimeout(() => element.classList.remove("paperclip-battler-input-blocked"), 220);
  };

  const blockTrustedInput = (event) => {
    if (!userInputLocked() || !event.isTrusted) return;
    if (event.type === "keydown" && event.key === "Tab") return;
    const target = closestInteractive(event.target);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    flashBlocked(target);
  };

  const noteUserActivity = (event) => {
    if (!event.isTrusted) return;
    lastUserActivityAt = Date.now();
    scheduleReport(80);
  };

  const blockShieldInput = (event) => {
    if (!userInputLocked() || !event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!inputShield) return;
    inputShield.classList.remove("paperclip-battler-input-blocked");
    void inputShield.offsetWidth;
    inputShield.classList.add("paperclip-battler-input-blocked");
    window.setTimeout(() => inputShield?.classList.remove("paperclip-battler-input-blocked"), 220);
  };

  const animateMcpPress = (element) => {
    element.classList.remove("paperclip-battler-mcp-press");
    void element.offsetWidth;
    element.classList.add("paperclip-battler-mcp-press");
    window.setTimeout(() => element.classList.remove("paperclip-battler-mcp-press"), 170);
  };

  const collectButtons = () =>
    buttonElements().map((element, index) => {
      const rect = element.getBoundingClientRect();
      const selector = elementSelector(element, index);
      const text = buttonText(element);
      return {
        id: element.id || "button-" + index,
        index,
        text,
        disabled: Boolean(element.disabled),
        visible: visible(element),
        selector,
        elementId: element.id || null,
        title: element.getAttribute("title") || "",
        value: element.value || "",
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    });

  const isManualPaperclipButton = (button) =>
    normalizeText(button.id).toLowerCase() === "btnmakepaperclip" ||
    normalizeText(button.text).toLowerCase() === "make paperclip";

  const isBuyWireButton = (button) => normalizeText(button.id).toLowerCase() === "btnbuywire";

  const manualPaperclipElement = () =>
    document.getElementById("btnMakePaperclip") ||
    buttonElements().find((element) => normalizeText(buttonText(element)).toLowerCase() === "make paperclip");

  const wireRecoveryProjectElement = () =>
    buttonElements().find((element) => /beg\s+for\s+more\s+wire/i.test(normalizeText(buttonText(element))));

  const elementById = (id) => document.getElementById(id);

  const parseGameNumber = (value) => {
    const parsed = Number.parseFloat(String(value || "").replace(/,/g, "").replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };

  const readGameNumber = (globalName, elementId) => {
    const fromGlobal = parseGameNumber(window[globalName]);
    if (fromGlobal !== null) return fromGlobal;
    return parseGameNumber(document.getElementById(elementId)?.textContent);
  };

  const formatGameNumber = (value, decimals = 0) => {
    if (value === null || typeof value === "undefined") return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (typeof window.formatWithCommas === "function") return window.formatWithCommas(number, decimals);
    return number.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  };

  const setGameText = (id, value, decimals = 0) => {
    const element = document.getElementById(id);
    const text = formatGameNumber(value, decimals);
    if (element && text !== null) element.textContent = text;
  };

  const syncVisibleStatsFromGlobals = () => {
    const clips = readGameNumber("clips", "clips");
    const clipmakerRate = readGameNumber("clipmakerRate", "clipmakerRate");
    setGameText("wire", readGameNumber("wire", "wire"));
    setGameText("wireCost", readGameNumber("wireCost", "wireCost"));
    setGameText("clips", clips === null ? null : Math.ceil(clips));
    setGameText("funds", readGameNumber("funds", "funds"), 2);
    setGameText("unsoldClips", readGameNumber("unsoldClips", "unsoldClips"));
    setGameText("margin", readGameNumber("margin", "margin"), 2);
    setGameText("clipmakerRate", clipmakerRate === null ? null : Math.round(clipmakerRate));
    setGameText("clipmakerLevel2", readGameNumber("clipmakerLevel", "clipmakerLevel2"));
    setGameText("clipperCost", readGameNumber("clipperCost", "clipperCost"), 2);
  };

  const findEnabledVisibleElement = (...ids) =>
    ids.map((id) => elementById(id)).find((element) => element && visible(element) && !element.disabled) || null;

  const readWireState = () => ({
    wire: readGameNumber("wire", "wire"),
    wireCost: readGameNumber("wireCost", "wireCost"),
    funds: readGameNumber("funds", "funds")
  });

  const knownButtonCashCost = (button) => {
    const id = normalizeText(button.id || button.elementId).toLowerCase();
    if (id === "btnmakeclipper") return readGameNumber("clipperCost", "clipperCost");
    if (id === "btnexpandmarketing") return readGameNumber("adCost", "adCost");
    if (id === "btnmakemegaclipper") return readGameNumber("megaClipperCost", "megaClipperCost");
    return null;
  };

  const preservesWireReserve = (button) => {
    const { wire, funds } = readWireState();
    if (wire === null || wire >= HEURISTIC_WIRE_SAVE_BELOW || funds === null) return true;

    const cashCost = knownButtonCashCost(button);
    if (cashCost === null || cashCost <= 0) return true;

    return funds - cashCost >= HEURISTIC_AVERAGE_WIRE_COST;
  };

  const visibleProjectOperationCosts = () =>
    collectButtons()
      .filter((button) => button.visible && /projectbutton/i.test(button.id || button.elementId || ""))
      .map((button) => parseGameNumber((button.text.match(/\(([\d,]+)\s+ops\)/i) || [])[1]))
      .filter((cost) => cost !== null)
      .sort((left, right) => left - right);

  const probeValue = (suffix) => readGameNumber("probe" + suffix, "probe" + suffix + "Display") || 0;

  const probeTarget = (suffix) => {
    if (suffix === "Combat" && (readGameNumber("drifterCount", "drifterCount") || 0) > 0) return 5;
    return HEURISTIC_PROBE_TARGETS[suffix] || 0;
  };

  const clickHeuristicElement = (element, cooldownKey, cooldownMs) => {
    if (!element || !visible(element) || element.disabled) return false;
    const now = Date.now();
    if ((heuristicCooldowns.get(cooldownKey) || 0) > now) return false;

    heuristicCooldowns.set(cooldownKey, now + cooldownMs);
    animateMcpPress(element);
    element.click();
    scheduleReport(80);
    return true;
  };

  const runWireHeuristic = () => {
    const { wire, wireCost, funds } = readWireState();
    const buyWireButton = document.getElementById("btnBuyWire");
    const canAffordWire = funds !== null && wireCost !== null && funds >= wireCost;

    if (wire !== null && wire < HEURISTIC_WIRE_STALL_BELOW) {
      if (canAffordWire) {
        clickHeuristicElement(buyWireButton, "wire:empty", HEURISTIC_WIRE_BUY_COOLDOWN_MS);
        return true;
      }

      if (funds !== null && wireCost !== null && funds < wireCost) {
        return clickHeuristicElement(wireRecoveryProjectElement(), "wire:beg", 1800);
      }

      return false;
    }

    const lowPriceRule = HEURISTIC_WIRE_LOW_PRICE_RULES.find((rule) => wireCost !== null && wireCost <= rule.maxCost);
    if (!lowPriceRule || wire === null || wire >= lowPriceRule.targetWire) return false;
    if (!canAffordWire) return false;

    clickHeuristicElement(buyWireButton, "wire:low:" + lowPriceRule.maxCost, HEURISTIC_WIRE_BUY_COOLDOWN_MS);
    return true;
  };

  const runPriceHeuristic = () => {
    const unsoldClips = readGameNumber("unsoldClips", "unsoldClips");
    const demand = readGameNumber("demand", "demand");
    const margin = readGameNumber("margin", "margin");
    if (unsoldClips === null) return false;

    if (demand !== null && demand <= HEURISTIC_LOW_DEMAND && (margin === null || margin > HEURISTIC_MIN_PRICE)) {
      return clickHeuristicElement(document.getElementById("btnLowerPrice"), "price:adjust", HEURISTIC_PRICE_COOLDOWN_MS);
    }

    if (unsoldClips > 150) {
      return clickHeuristicElement(document.getElementById("btnLowerPrice"), "price:adjust", HEURISTIC_PRICE_COOLDOWN_MS);
    }

    if (
      unsoldClips > 75 &&
      demand !== null &&
      demand < HEURISTIC_HEALTHY_DEMAND &&
      (margin === null || margin > HEURISTIC_MIN_PRICE)
    ) {
      return clickHeuristicElement(document.getElementById("btnLowerPrice"), "price:adjust", HEURISTIC_PRICE_COOLDOWN_MS);
    }

    if (unsoldClips < 50 && (demand === null || demand >= HEURISTIC_HEALTHY_DEMAND)) {
      return clickHeuristicElement(document.getElementById("btnRaisePrice"), "price:adjust", HEURISTIC_PRICE_COOLDOWN_MS);
    }

    return false;
  };

  const runTrustHeuristic = () => {
    const addProcButton = findEnabledVisibleElement("btnAddProc");
    const addMemButton = findEnabledVisibleElement("btnAddMem");
    if (!addProcButton && !addMemButton) return false;

    const processors = readGameNumber("processors", "processors") || 1;
    const memory = readGameNumber("memory", "memory") || 1;
    const operations = readGameNumber("operations", "operations") || 0;
    const maxOps = memory * 1000;
    const nextOpsCapacityCost = visibleProjectOperationCosts().find((cost) => cost > maxOps);

    if (addMemButton && nextOpsCapacityCost && maxOps < nextOpsCapacityCost) {
      return clickHeuristicElement(addMemButton, "trust:memory:project-capacity", 750);
    }

    if (addMemButton && operations >= maxOps * 0.92 && maxOps < 250000) {
      return clickHeuristicElement(addMemButton, "trust:memory:full-capacity", 750);
    }

    if (addProcButton && processors < Math.max(5, memory)) {
      return clickHeuristicElement(addProcButton, "trust:processors", 750);
    }

    if (addMemButton && memory <= processors && maxOps < 250000) {
      return clickHeuristicElement(addMemButton, "trust:memory:balance", 750);
    }

    if (addProcButton) return clickHeuristicElement(addProcButton, "trust:processors:fallback", 750);
    return clickHeuristicElement(addMemButton, "trust:memory:fallback", 750);
  };

  const runTournamentHeuristic = () => {
    const strategyPicker = elementById("stratPicker");
    if (strategyPicker && visible(strategyPicker) && !strategyPicker.disabled && strategyPicker.value === "10") {
      strategyPicker.value = "0";
      dispatchValueEvents(strategyPicker);
      scheduleReport(80);
      return true;
    }

    const tournamentButton = findEnabledVisibleElement("btnRunTournament", "btnNewTournament");
    return clickHeuristicElement(tournamentButton, "tournament:run", 900);
  };

  const runProbeHeuristic = () => {
    const probeTrust = readGameNumber("probeTrust", "probeTrustDisplay");
    if (probeTrust === null) return false;

    const usedTrust = readGameNumber("probeUsedTrust", "probeTrustUsedDisplay") || 0;
    const increaseProbeTrustButton = findEnabledVisibleElement("btnIncreaseProbeTrust", "btnIncreaseMaxTrust");
    if (increaseProbeTrustButton && usedTrust >= probeTrust) {
      return clickHeuristicElement(increaseProbeTrustButton, "probe:trust", 900);
    }

    for (const suffix of HEURISTIC_PROBE_TARGET_ORDER) {
      if (probeValue(suffix) >= probeTarget(suffix)) continue;
      const raiseButton = findEnabledVisibleElement("btnRaiseProbe" + suffix);
      if (raiseButton) return clickHeuristicElement(raiseButton, "probe:raise:" + suffix, 450);
    }

    if (increaseProbeTrustButton) {
      return clickHeuristicElement(increaseProbeTrustButton, "probe:trust:surplus", 900);
    }

    return clickHeuristicElement(findEnabledVisibleElement("btnMakeProbe"), "probe:launch", 900);
  };

  const heuristicKey = (button) => normalizeText(button.id || button.text || button.selector).toLowerCase();

  const heuristicDecisionForButton = (button) => {
    if (!button.visible || button.disabled) return null;
    if (isManualPaperclipButton(button)) return null;
    if (isBuyWireButton(button)) return null;
    if (!preservesWireReserve(button)) return null;
    const haystack = [button.id, button.text, button.title, button.value].map(normalizeText).join(" ");
    if (!haystack || HEURISTIC_SKIP_PATTERN.test(haystack)) return null;

    let best = button.text || button.id ? { score: 24, cooldownMs: 1400 } : null;
    for (const rule of HEURISTIC_BUTTON_RULES) {
      if (!rule.pattern.test(haystack)) continue;
      if (!best || rule.score > best.score) best = rule;
    }

    return best;
  };

  const chooseHeuristicButton = () => {
    const now = Date.now();
    return collectButtons()
      .map((button) => {
        const decision = heuristicDecisionForButton(button);
        if (!decision) return null;
        const key = heuristicKey(button);
        if ((heuristicCooldowns.get(key) || 0) > now) return null;
        return { button, decision, key };
      })
      .filter(Boolean)
      .sort((left, right) => right.decision.score - left.decision.score || left.button.index - right.button.index)[0];
  };

  const runHeuristicTick = () => {
    if (!heuristicCanAct() || !allPlayersReady) return;
    syncVisibleStatsFromGlobals();
    if (runWireHeuristic()) return;
    if (runPriceHeuristic()) return;
    if (runTournamentHeuristic()) return;
    if (runProbeHeuristic()) return;
    if (runTrustHeuristic()) return;

    const target = chooseHeuristicButton();
    if (!target) return;

    const element = document.querySelector(target.button.selector);
    clickHeuristicElement(element, target.key, target.decision.cooldownMs);
  };

  const runManualPaperclipTick = () => {
    if (!heuristicCanAct() || !allPlayersReady) return;
    const element = manualPaperclipElement();
    if (!element || !visible(element) || element.disabled) return;

    suppressClickReportUntil = Date.now() + 50;
    element.click();
  };

  const findLabel = (element) => {
    if (element.id) {
      const label = document.querySelector('label[for="' + cssEscape(element.id) + '"]');
      if (label) return normalizeText(label.innerText);
    }
    return normalizeText(
      element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.name ||
        element.id ||
        element.closest("td,div,p,span")?.innerText
    );
  };

  const collectControls = () =>
    controlElements().map((element, index) => {
      const selector = elementSelector(element, index);
      return {
        id: element.id || element.name || "control-" + index,
        index,
        tag: element.tagName.toLowerCase(),
        type: element.type || element.tagName.toLowerCase(),
        label: findLabel(element),
        value: element.value || "",
        checked: Boolean(element.checked),
        disabled: Boolean(element.disabled),
        visible: visible(element),
        selector,
        elementId: element.id || null,
        options:
          element.tagName.toLowerCase() === "select"
            ? Array.from(element.options).map((option) => option.value || option.text)
            : undefined
      };
    });

  const report = async () => {
    if (reportTimer) {
      window.clearTimeout(reportTimer);
      reportTimer = null;
    }
    if (reportInFlight) {
      reportAgainAfterInFlight = true;
      return;
    }
    reportInFlight = true;
    lastReportAt = Date.now();

    try {
      syncVisibleStatsFromGlobals();
      await fetch(REPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          at: Date.now(),
          lastUserActivityAt: lastUserActivityAt || undefined,
          roomId: ROOM_ID,
          playerId: PLAYER_ID,
          mode: playerMode,
          url: window.location.href,
          title: document.title,
          buttons: collectButtons(),
          controls: collectControls(),
          visibleText: normalizeText(document.body?.innerText || "").slice(0, 10000),
          save: {
            localStorage: collectStorage(window.localStorage),
            sessionStorage: collectStorage(window.sessionStorage)
          }
        })
      });
    } catch {
      // The bridge may be restarting.
    } finally {
      reportInFlight = false;
      if (reportAgainAfterInFlight) {
        reportAgainAfterInFlight = false;
        scheduleReport(REPORT_MIN_INTERVAL_MS);
      }
    }
  };

  const scheduleReport = (delayMs = 100) => {
    if (reportTimer) return;
    const elapsed = Date.now() - lastReportAt;
    const waitMs = Math.max(delayMs, REPORT_MIN_INTERVAL_MS - elapsed);
    reportTimer = window.setTimeout(report, Math.max(0, waitMs));
  };

  const findButton = (command) => {
    const buttons = collectButtons();
    const text = normalizeText(command.text).toLowerCase();
    const target =
      buttons.find((button) => button.id === command.buttonId) ||
      buttons.find((button) => button.selector === command.selector) ||
      (text
        ? buttons.find((button) => button.text.toLowerCase() === text || button.text.toLowerCase().includes(text))
        : null);
    if (!target) return null;
    return document.querySelector(target.selector);
  };

  const findControl = (command) => {
    const controls = collectControls();
    const target =
      controls.find((control) => control.id === command.controlId) ||
      controls.find((control) => control.selector === command.selector);
    if (!target) return null;
    return document.querySelector(target.selector);
  };

  const dispatchValueEvents = (element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const collectStorage = (storage) => {
    const values = {};
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) values[key] = storage.getItem(key) || "";
    }
    return values;
  };

  const importStorage = (storage, values) => {
    storage.clear();
    for (const [key, value] of Object.entries(values || {})) {
      storage.setItem(key, String(value));
    }
  };

  const runCommand = async (command) => {
    const result = { id: command.id, ok: true, message: "ok", at: Date.now() };
    try {
      await refreshConfig();

      if (command.type === "click") {
        if (!agentCanAct()) throw new Error("This player is not in Agent or Both mode.");
        if (!allPlayersReady) throw new Error(playerReady ? "Waiting for the other player to be ready before actions can run." : "You need to be ready before taking actions.");
        const button = findButton(command);
        if (!button) throw new Error("Button not found.");
        if (button.disabled) throw new Error("Button is disabled.");
        animateMcpPress(button);
        button.click();
        result.message = "Clicked " + buttonText(button) + ".";
      } else if (command.type === "set-control") {
        if (!agentCanAct()) throw new Error("This player is not in Agent or Both mode.");
        if (!allPlayersReady) throw new Error(playerReady ? "Waiting for the other player to be ready before actions can run." : "You need to be ready before taking actions.");
        const control = findControl(command);
        if (!control) throw new Error("Control not found.");
        if (control.disabled) throw new Error("Control is disabled.");
        if (control.type === "checkbox" || control.type === "radio") {
          control.checked = command.value === true || String(command.value).toLowerCase() === "true";
        } else {
          control.value = command.value;
        }
        dispatchValueEvents(control);
        result.message = "Set control.";
      } else if (command.type === "reset") {
        window.localStorage.clear();
        window.sessionStorage.clear();
        result.message = "Resetting page.";
        window.setTimeout(() => window.location.reload(), 50);
      } else if (command.type === "import-save") {
        importStorage(window.localStorage, command.save?.localStorage);
        importStorage(window.sessionStorage, command.save?.sessionStorage);
        result.message = "Imported save. Reloading page.";
        window.setTimeout(() => window.location.reload(), 50);
      }
    } catch (error) {
      result.ok = false;
      result.message = error instanceof Error ? error.message : "Command failed.";
    }

    try {
      await fetch(RESULT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result)
      });
    } finally {
      scheduleReport(100);
    }
  };

  const poll = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const response = await fetch(COMMAND_URL, { cache: "no-store" });
      const command = await response.json();
      if (command && command.id) await runCommand(command);
    } catch {
      // The bridge may be restarting.
    } finally {
      pollInFlight = false;
    }
  };

  installStyles();
  setPlayerMode("human");
  setReadyState(false, false);
  refreshConfig();
  report();
  startHeuristicTickStream();
  window.addEventListener("load", report);
  window.addEventListener("click", () => {
    if (Date.now() < suppressClickReportUntil) return;
    scheduleReport(80);
  }, true);
  window.addEventListener("change", () => scheduleReport(80), true);
  for (const eventName of ["pointerdown", "click", "keydown", "change", "input"]) {
    window.addEventListener(eventName, noteUserActivity, true);
  }
  for (const eventName of [
    "pointerdown",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "touchstart",
    "touchend",
    "input",
    "change",
    "keydown"
  ]) {
    window.addEventListener(eventName, blockTrustedInput, true);
  }
  window.setInterval(refreshConfig, 500);
  window.setInterval(report, 1000);
  window.setInterval(poll, 250);
  window.setInterval(() => {
    if (!bridgeHeuristicTicksFresh()) runHeuristicTick();
  }, HEURISTIC_DECISION_TICK_MS);
  window.setInterval(() => {
    if (!bridgeHeuristicTicksFresh()) runManualPaperclipTick();
  }, HEURISTIC_MANUAL_CLIP_TICK_MS);
})();
`;
