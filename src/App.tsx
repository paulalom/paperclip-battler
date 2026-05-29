import {
  Bot,
  Check,
  Copy,
  Download,
  Eye,
  ExternalLink,
  Link,
  Lock,
  Plus,
  RefreshCcw,
  RotateCcw,
  Server,
  SplitSquareVertical,
  Unlock,
  Upload,
  User,
  Users
} from "lucide-react";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

const ORIGINAL_URL = "https://www.decisionproblem.com/paperclips/index2.html";
const BRIDGE_URL_KEY = "paperclip-battler:bridge-url";
const PLAYER_MODE_KEY = "paperclip-battler:player-modes";
const ROOM_ID_KEY = "paperclip-battler:room-id";
const DEFAULT_ROOM_ID = "local";
const PLAYER_IDS = ["left", "right"] as const;
const PLAYER_LABELS: Record<PlayerId, string> = {
  left: "Player 1",
  right: "Player 2"
};

async function syncPlayerModesToBridge(baseUrl: string, roomId: string, modes: Record<PlayerId, PlayerMode>) {
  const responses = await Promise.all(
    PLAYER_IDS.map((playerId) =>
      fetch(`${baseUrl}/players/mode?room=${encodeURIComponent(roomId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: roomId, player: playerId, mode: modes[playerId] })
      })
    )
  );
  if (responses.some((response) => !response.ok)) throw new Error("Bridge rejected player mode sync.");
}
const DEFAULT_PLAYER_MODES: Record<PlayerId, PlayerMode> = {
  left: "human",
  right: "agent"
};

type PlayerId = (typeof PLAYER_IDS)[number];
type PlayerMode = "human" | "agent" | "both";

type BridgePlayerHealth = {
  id: PlayerId;
  label: string;
  mode: PlayerMode;
  ready: boolean;
  agentEnabled: boolean;
  userClicksAllowed: boolean;
  connected: boolean;
  agentConnected: boolean;
  lastReportAt: number | null;
  buttonCount: number;
  claim: BridgePlayerClaim | null;
  report: BridgeReport | null;
};

type BridgeReport = {
  at: number;
  url: string;
  title: string;
  visibleText: string;
  buttons: Array<{
    id: string;
    index: number;
    text: string;
    visible: boolean;
  }>;
  controls: unknown[];
};

type BridgePlayerClaim = {
  tokenSuffix: string;
  label: string;
  source: "mcp" | "http";
  claimedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ttlMs: number;
};

type BridgeRoomSlot = {
  player: PlayerId;
  label: string;
  mode: PlayerMode;
  ready: boolean;
  connected: boolean;
  lastSeenAt: number | null;
  claim: BridgePlayerClaim | null;
};

type BridgeRoom = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  tinyState: Record<string, unknown>;
  roomUrl: string;
  watchUrl: string;
  spectatorCount: number;
  eventCount: number;
  snapshotCount: number;
  slots: Partial<Record<PlayerId, BridgeRoomSlot>>;
};

type BridgeHealth = {
  ok: boolean;
  room?: BridgeRoom;
  roomId?: string;
  roomUrl?: string;
  watchUrl?: string;
  bridgeUrl: string;
  agentUrl: string;
  playerUrls?: Record<PlayerId, string>;
  allPlayersReady: boolean;
  agentConnected: boolean;
  lastReportAt: number | null;
  buttonCount: number;
  players?: Partial<Record<PlayerId, BridgePlayerHealth>>;
};

type BridgeStatus = "checking" | "connected" | "offline";
type RoomView = "play" | "watch";
type AppRoute = {
  roomId: string | null;
  view: RoomView;
  embedded: boolean;
};

export function App() {
  const initialRoute = readRoomRoute();
  const [bridgeUrl, setBridgeUrl] = useState(() => readInitialBridgeUrl());
  const [roomId, setRoomId] = useState(() => initialRoute.roomId ?? localStorage.getItem(ROOM_ID_KEY) ?? DEFAULT_ROOM_ID);
  const [roomView, setRoomView] = useState<RoomView>(() => initialRoute.view);
  const [embedded, setEmbedded] = useState(() => initialRoute.embedded);
  const [roomNotice, setRoomNotice] = useState("");
  const [playerModes, setPlayerModes] = useState<Record<PlayerId, PlayerMode>>(readPlayerModes);
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [status, setStatus] = useState<BridgeStatus>("checking");
  const importInputRef = useRef<HTMLInputElement>(null);
  const leftFrame = useRef<HTMLIFrameElement>(null);
  const rightFrame = useRef<HTMLIFrameElement>(null);

  const frameRefs: Record<PlayerId, React.RefObject<HTMLIFrameElement>> = {
    left: leftFrame,
    right: rightFrame
  };
  const trimmedBridgeUrl = useMemo(() => bridgeUrl.replace(/\/+$/, ""), [bridgeUrl]);
  const playUrl = `${window.location.origin}/rooms/${encodeURIComponent(roomId)}`;
  const watchUrl = `${window.location.origin}/watch/${encodeURIComponent(roomId)}`;

  useEffect(() => {
    localStorage.setItem(BRIDGE_URL_KEY, bridgeUrl);
  }, [bridgeUrl]);

  useEffect(() => {
    localStorage.setItem(ROOM_ID_KEY, roomId);
  }, [roomId]);

  useEffect(() => {
    const onPopState = () => {
      const nextRoute = readRoomRoute();
      setRoomId(nextRoute.roomId ?? localStorage.getItem(ROOM_ID_KEY) ?? DEFAULT_ROOM_ID);
      setRoomView(nextRoute.view);
      setEmbedded(nextRoute.embedded);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    localStorage.setItem(PLAYER_MODE_KEY, JSON.stringify(playerModes));
  }, [playerModes]);

  useEffect(() => {
    let cancelled = false;

    async function syncModes() {
      try {
        await syncPlayerModesToBridge(trimmedBridgeUrl, roomId, playerModes);
      } catch {
        if (!cancelled) setStatus("offline");
      }
    }

    syncModes();
    return () => {
      cancelled = true;
    };
  }, [playerModes, roomId, trimmedBridgeUrl]);

  useEffect(() => {
    let cancelled = false;

    async function pollHealth() {
      try {
        const response = await fetch(`${trimmedBridgeUrl}/health?room=${encodeURIComponent(roomId)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
        let nextHealth = (await response.json()) as BridgeHealth;
        const bridgeModeMismatch = PLAYER_IDS.some((playerId) => nextHealth.players?.[playerId]?.mode !== playerModes[playerId]);
        if (bridgeModeMismatch) {
          await syncPlayerModesToBridge(trimmedBridgeUrl, roomId, playerModes);
          const syncedPlayers: Partial<Record<PlayerId, BridgePlayerHealth>> = { ...(nextHealth.players ?? {}) };
          for (const playerId of PLAYER_IDS) {
            const player = syncedPlayers[playerId];
            if (!player) continue;
            const mode = playerModes[playerId];
            syncedPlayers[playerId] = {
              ...player,
              mode,
              agentEnabled: mode !== "human",
              userClicksAllowed: mode !== "agent"
            };
          }
          nextHealth = {
            ...nextHealth,
            players: syncedPlayers
          };
        }
        if (!cancelled) {
          setHealth(nextHealth);
          setStatus("connected");
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
          setStatus("offline");
        }
      }
    }

    setStatus("checking");
    pollHealth();
    const timer = window.setInterval(pollHealth, 1_250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [playerModes, roomId, trimmedBridgeUrl]);

  useEffect(() => {
    if (!roomId) return;
    const events = new EventSource(`${trimmedBridgeUrl}/rooms/${encodeURIComponent(roomId)}/events`);
    const markConnected = () => setStatus((current) => (current === "offline" ? "checking" : current));
    events.addEventListener("snapshot", markConnected);
    events.addEventListener("room", markConnected);
    events.onerror = () => events.close();
    return () => events.close();
  }, [roomId, trimmedBridgeUrl]);

  function playerUrl(playerId: PlayerId) {
    return `${trimmedBridgeUrl}/rooms/${encodeURIComponent(roomId)}/players/${playerId}/index2.html`;
  }

  function spectatorUrl(playerId: PlayerId) {
    return `${trimmedBridgeUrl}/watch/${encodeURIComponent(roomId)}/players/${playerId}/index2.html`;
  }

  function reloadPlayer(playerId: PlayerId) {
    const frame = frameRefs[playerId].current;
    if (frame) {
      frame.src = `${playerUrl(playerId)}?reload=${Date.now()}`;
    }
  }

  async function resetPlayer(playerId: PlayerId) {
    try {
      await fetch(`${trimmedBridgeUrl}/player-control/manual-reset?room=${encodeURIComponent(roomId)}&player=${playerId}`, {
        method: "POST"
      });
    } finally {
      const frame = frameRefs[playerId].current;
      if (frame) {
        frame.src = `${playerUrl(playerId)}?reset=${Date.now()}`;
      }
    }
  }

  async function setPlayerReady(playerId: PlayerId, ready: boolean) {
    setHealth((current) => {
      const currentPlayer = current?.players?.[playerId];
      if (!current || !currentPlayer) return current;
      return {
        ...current,
        allPlayersReady: false,
        players: {
          ...current.players,
          [playerId]: {
            ...currentPlayer,
            ready
          }
        }
      };
    });

    try {
      const response = await fetch(`${trimmedBridgeUrl}/players/ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: roomId, player: playerId, ready, force: true })
      });
      if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
      const payload = (await response.json()) as Pick<BridgeHealth, "allPlayersReady" | "players">;
      setHealth((current) => (current ? { ...current, ...payload } : current));
    } catch {
      setStatus("offline");
    }
  }

  async function releasePlayerClaim(playerId: PlayerId) {
    try {
      const response = await fetch(`${trimmedBridgeUrl}/players/claim/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: roomId, player: playerId, force: true })
      });
      if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
      setHealth((current) => {
        const currentPlayer = current?.players?.[playerId];
        if (!current || !currentPlayer) return current;
        return {
          ...current,
          players: {
            ...current.players,
            [playerId]: {
              ...currentPlayer,
              claim: null
            }
          }
        };
      });
    } catch {
      setStatus("offline");
    }
  }

  function setPlayerMode(playerId: PlayerId, mode: PlayerMode) {
    setPlayerModes((current) => ({ ...current, [playerId]: mode }));
    setHealth((current) => {
      const currentPlayer = current?.players?.[playerId];
      if (!current || !currentPlayer) return current;
      return {
        ...current,
        players: {
          ...current.players,
          [playerId]: {
            ...currentPlayer,
            mode,
            agentEnabled: mode !== "human",
            userClicksAllowed: mode !== "agent"
          }
        }
      };
    });
  }

  function navigateRoom(nextRoomId: string, nextView: RoomView) {
    const normalized = normalizeRoomId(nextRoomId);
    setRoomId(normalized);
    setRoomView(nextView);
    const nextPath = roomRoutePath(normalized, nextView, embedded);
    window.history.pushState({}, "", nextPath);
  }

  async function createRoom() {
    try {
      const response = await fetch(`${trimmedBridgeUrl}/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Paperclip Battler" })
      });
      if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
      const payload = (await response.json()) as { room?: BridgeRoom };
      if (!payload.room?.id) throw new Error("Bridge did not return a room id.");
      navigateRoom(payload.room.id, "play");
      setRoomNotice(`Room ${payload.room.id} ready`);
    } catch {
      setStatus("offline");
      setRoomNotice("Room bridge offline");
    }
  }

  async function copyRoomUrl(kind: RoomView) {
    const url = kind === "watch" ? watchUrl : playUrl;
    try {
      await navigator.clipboard.writeText(url);
      setRoomNotice(kind === "watch" ? "Watch link copied" : "Play link copied");
    } catch {
      setRoomNotice(url);
    }
  }

  async function exportRoom() {
    try {
      const response = await fetch(`${trimmedBridgeUrl}/rooms/${encodeURIComponent(roomId)}/export`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
      const blob = new Blob([JSON.stringify(await response.json(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `paperclip-room-${roomId}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setRoomNotice("Room exported");
    } catch {
      setStatus("offline");
      setRoomNotice("Export failed");
    }
  }

  async function importRoom(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const response = await fetch(`${trimmedBridgeUrl}/rooms/${encodeURIComponent(roomId)}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
      setRoomNotice("Room imported");
    } catch {
      setRoomNotice("Import failed");
    }
  }

  return (
    <main className={`app-shell ${embedded ? "embedded" : ""}`}>
      {!embedded ? (
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              <SplitSquareVertical size={24} />
            </div>
            <div>
              <h1>Paperclip Battler</h1>
              <a href={ORIGINAL_URL} target="_blank" rel="noreferrer">
                Universal Paperclips <ExternalLink size={13} />
              </a>
            </div>
          </div>

          <div className="topbar-tools">
            <div className="room-bar">
              <button className="icon-button" onClick={createRoom} title="Create room">
                <Plus size={16} />
              </button>
              <button
                className={`room-chip ${roomView === "play" ? "active" : ""}`}
                onClick={() => navigateRoom(roomId, "play")}
                title={playUrl}
              >
                <Link size={14} />
                <span>{roomId}</span>
              </button>
              <button
                className={`icon-button ${roomView === "watch" ? "active" : ""}`}
                onClick={() => navigateRoom(roomId, "watch")}
                title={watchUrl}
              >
                <Eye size={16} />
              </button>
              <button className="icon-button" onClick={() => copyRoomUrl("play")} title="Copy play link">
                <Copy size={16} />
              </button>
              <button className="icon-button" onClick={() => copyRoomUrl("watch")} title="Copy watch link">
                <Eye size={16} />
              </button>
              <button className="icon-button" onClick={exportRoom} title="Export room">
                <Download size={16} />
              </button>
              <button className="icon-button" onClick={() => importInputRef.current?.click()} title="Import room">
                <Upload size={16} />
              </button>
              <input ref={importInputRef} className="hidden-file" type="file" accept="application/json,.json" onChange={importRoom} />
              {roomNotice ? <span className="room-notice">{roomNotice}</span> : null}
            </div>
            <div className="bridge-bar">
              <span className={`status-pill ${status}`}>{bridgeLabel(status, health)}</span>
              <input
                aria-label="MCP bridge URL"
                value={bridgeUrl}
                onChange={(event) => setBridgeUrl(event.target.value)}
                spellCheck={false}
              />
              <button className="icon-button" onClick={() => setBridgeUrl("http://127.0.0.1:8787")} title="Reset bridge URL">
                <RefreshCcw size={16} />
              </button>
            </div>
          </div>
        </header>
      ) : null}

      {roomView === "watch" ? (
        <WatchView health={health} status={status} playerModes={playerModes} sourceForPlayer={spectatorUrl} />
      ) : (
        <section className="split-view">
          {PLAYER_IDS.map((playerId) => (
            <OriginalPane
              key={playerId}
              title={PLAYER_LABELS[playerId]}
              source={playerUrl(playerId)}
              mode={playerModes[playerId]}
              health={health?.players?.[playerId]}
              frameRef={frameRefs[playerId]}
              disabled={status === "offline"}
              allPlayersReady={Boolean(health?.allPlayersReady)}
              onModeChange={(mode) => setPlayerMode(playerId, mode)}
              onReadyChange={(ready) => setPlayerReady(playerId, ready)}
              onReload={() => reloadPlayer(playerId)}
              onReset={() => resetPlayer(playerId)}
              onReleaseClaim={() => releasePlayerClaim(playerId)}
            />
          ))}
        </section>
      )}
    </main>
  );
}

function WatchView({
  health,
  status,
  playerModes,
  sourceForPlayer
}: {
  health: BridgeHealth | null;
  status: BridgeStatus;
  playerModes: Record<PlayerId, PlayerMode>;
  sourceForPlayer: (playerId: PlayerId) => string;
}) {
  const noop = () => undefined;
  return (
    <section className="split-view watch-split-view">
      {PLAYER_IDS.map((playerId) => (
        <OriginalPane
          key={playerId}
          title={PLAYER_LABELS[playerId]}
          source={sourceForPlayer(playerId)}
          mode={health?.players?.[playerId]?.mode ?? playerModes[playerId]}
          health={health?.players?.[playerId]}
          disabled={status === "offline"}
          allPlayersReady={Boolean(health?.allPlayersReady)}
          readOnly
          onModeChange={noop}
          onReadyChange={noop}
          onReload={noop}
          onReset={noop}
          onReleaseClaim={noop}
        />
      ))}
    </section>
  );
}

function SnapshotPane({ title, health }: { title: string; health?: BridgePlayerHealth }) {
  const report = health?.report;
  const buttons = report?.buttons.filter((button) => button.visible).slice(0, 10) ?? [];

  return (
    <article className="snapshot-pane">
      <div className="snapshot-title">
        <span>{title}</span>
        <span className={`mode-badge ${health?.mode ?? "human"}`}>{modeLabel(health?.mode ?? "human")}</span>
        <span className={`ready-badge ${health?.ready ? "ready" : "waiting"}`}>
          <Check size={14} />
          {health?.ready ? "Ready" : "Not ready"}
        </span>
      </div>
      <div className="snapshot-body">
        <p>{report?.visibleText || "No live snapshot yet."}</p>
        <div className="snapshot-buttons">
          {buttons.map((button) => (
            <span key={`${button.id}-${button.index}`}>{button.text || button.id}</span>
          ))}
        </div>
      </div>
    </article>
  );
}

function OriginalPane({
  title,
  source,
  mode,
  health,
  frameRef,
  disabled,
  allPlayersReady,
  onModeChange,
  onReadyChange,
  onReload,
  onReset,
  onReleaseClaim,
  readOnly = false
}: {
  title: string;
  source: string;
  mode: PlayerMode;
  health?: BridgePlayerHealth;
  frameRef?: React.RefObject<HTMLIFrameElement>;
  disabled: boolean;
  allPlayersReady: boolean;
  onModeChange: (mode: PlayerMode) => void;
  onReadyChange: (ready: boolean) => void;
  onReload: () => void;
  onReset: () => void;
  onReleaseClaim: () => void;
  readOnly?: boolean;
}) {
  const connected = Boolean(health?.connected);
  const buttonCount = health?.buttonCount ?? 0;
  const claim = health?.claim ?? null;
  const ready = Boolean(health?.ready);
  const readyLocked = mode === "agent";
  const controlsDisabled = disabled || readOnly;
  const readyDisabled = controlsDisabled || readyLocked;
  const readyTitle = readOnly
    ? `${title} is read-only in watch view`
    : readyLocked
      ? `${title} is Agent-only. Use set_agent_player_ready from MCP.`
      : ready
        ? `${title} is ready`
        : `Mark ${title} ready`;

  return (
    <article className={`pane mode-${mode} ${readOnly ? "read-only" : ""}`}>
      <div className="pane-toolbar">
        <div className="pane-title">
          <span>{title}</span>
          <span className={`mode-badge ${mode}`}>{modeLabel(mode)}</span>
          <span className={`ready-badge ${ready ? "ready" : "waiting"}`}>
            <Check size={14} />
            {ready ? "Ready" : "Not ready"}
          </span>
          {!allPlayersReady ? (
            <span className="agent-badge gate" title="Both players must be ready first.">
              <Lock size={14} />
              Input held
            </span>
          ) : null}
          {mode !== "human" ? (
            <span className={`agent-badge ${connected ? "online" : "waiting"}`}>
              <Server size={14} />
              {buttonCount} buttons
            </span>
          ) : null}
          {mode === "agent" ? (
            <span className="agent-badge locked">
              <Lock size={14} />
              Mouse locked
            </span>
          ) : null}
          {readOnly ? (
            <span className="agent-badge locked">
              <Eye size={14} />
              Watch only
            </span>
          ) : null}
          {claim ? (
            <span className="agent-badge claimed" title={`Token ending ${claim.tokenSuffix}, expires in ${formatTtl(claim.ttlMs)}`}>
              <Lock size={14} />
              {claim.label}
            </span>
          ) : null}
        </div>
        <div className="pane-actions">
          <button
            className={`ready-button ${ready ? "ready" : ""} ${readyLocked ? "locked" : ""}`}
            disabled={readyDisabled}
            onClick={() => {
              if (readyLocked) return;
              onReadyChange(!ready);
            }}
            title={readyTitle}
          >
            <Check size={15} />
            <span>{ready ? "Ready" : "Ready?"}</span>
          </button>
          <PlayerModePicker mode={mode} disabled={controlsDisabled} onSelect={onModeChange} />
          {claim ? (
            <button className="icon-button" disabled={controlsDisabled} onClick={onReleaseClaim} title={`Release MCP claim for ${title}`}>
              <Unlock size={16} />
            </button>
          ) : null}
          <button className="icon-button" disabled={controlsDisabled} onClick={onReload} title={`Reload ${title}`}>
            <RefreshCcw size={16} />
          </button>
          <button className="icon-button" disabled={controlsDisabled} onClick={onReset} title={`Reset ${title}`}>
            <RotateCcw size={16} />
          </button>
        </div>
      </div>
      <iframe ref={frameRef} src={source} title={`${title} Universal Paperclips`} />
    </article>
  );
}

function PlayerModePicker({
  mode,
  disabled,
  onSelect
}: {
  mode: PlayerMode;
  disabled: boolean;
  onSelect: (mode: PlayerMode) => void;
}) {
  return (
    <div className="mode-picker" aria-label="Player control mode">
      {(["human", "agent", "both"] as PlayerMode[]).map((option) => (
        <button
          key={option}
          className={mode === option ? "active" : ""}
          disabled={disabled}
          onClick={() => onSelect(option)}
          title={modeTitle(option)}
        >
          {modeIcon(option)}
          <span>{modeLabel(option)}</span>
        </button>
      ))}
    </div>
  );
}

function bridgeLabel(status: BridgeStatus, health: BridgeHealth | null) {
  if (status === "checking") return "MCP checking";
  if (status === "offline") return "MCP offline";
  const players = health?.players ? PLAYER_IDS.filter((playerId) => health.players?.[playerId]?.connected).length : 0;
  return players > 0 ? `MCP ${players}/2 panes` : "MCP waiting";
}

function readRoomRoute(): AppRoute {
  const embedded = isEmbeddedRoute();
  const queryRoom = getQueryRoomId();
  const embedMatch = window.location.pathname.match(/^\/embed(?:\/(rooms|watch))?\/([^/]+)/);
  if (embedMatch) {
    return {
      roomId: normalizeRoomId(decodeURIComponent(embedMatch[2])),
      view: embedMatch[1] === "watch" ? "watch" : "play",
      embedded: true
    };
  }

  const match = window.location.pathname.match(/^\/(rooms|watch)\/([^/]+)/);
  if (!match) {
    return {
      roomId: queryRoom,
      view: queryView(),
      embedded
    };
  }

  return {
    roomId: normalizeRoomId(decodeURIComponent(match[2])),
    view: match[1] === "watch" ? "watch" : "play",
    embedded
  };
}

function readInitialBridgeUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("bridgeUrl")?.trim() || params.get("bridge")?.trim() || localStorage.getItem(BRIDGE_URL_KEY) || "http://127.0.0.1:8787";
}

function isEmbeddedRoute() {
  const params = new URLSearchParams(window.location.search);
  const flag = params.get("embed") ?? params.get("embedded");
  if (window.location.pathname === "/embed" || window.location.pathname.startsWith("/embed/")) return true;
  if (flag === null) return false;
  return !["0", "false", "no", "off"].includes(flag.toLowerCase());
}

function getQueryRoomId() {
  const room = new URLSearchParams(window.location.search).get("room");
  return room ? normalizeRoomId(room) : null;
}

function queryView(): RoomView {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "watch" ? "watch" : "play";
}

function roomRoutePath(roomId: string, view: RoomView, embedded: boolean) {
  const encodedRoom = encodeURIComponent(roomId);
  if (embedded) return view === "watch" ? `/embed/watch/${encodedRoom}` : `/embed/${encodedRoom}`;
  return `${view === "watch" ? "/watch" : "/rooms"}/${encodedRoom}`;
}

function normalizeRoomId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || DEFAULT_ROOM_ID;
}

function readPlayerModes(): Record<PlayerId, PlayerMode> {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYER_MODE_KEY) ?? "{}") as Partial<Record<PlayerId, PlayerMode>>;
    return {
      left: isPlayerMode(saved.left) ? saved.left : DEFAULT_PLAYER_MODES.left,
      right: isPlayerMode(saved.right) ? saved.right : DEFAULT_PLAYER_MODES.right
    };
  } catch {
    return DEFAULT_PLAYER_MODES;
  }
}

function isPlayerMode(value: unknown): value is PlayerMode {
  return value === "human" || value === "agent" || value === "both";
}

function modeLabel(mode: PlayerMode) {
  if (mode === "agent") return "Agent";
  if (mode === "both") return "Both";
  return "Human";
}

function modeTitle(mode: PlayerMode) {
  if (mode === "agent") return "MCP only";
  if (mode === "both") return "Human and MCP";
  return "Human only";
}

function modeIcon(mode: PlayerMode) {
  if (mode === "agent") return <Bot size={14} />;
  if (mode === "both") return <Users size={14} />;
  return <User size={14} />;
}

function formatTtl(ttlMs: number) {
  const seconds = Math.max(0, Math.ceil(ttlMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}
