import {
  Bot,
  BrainCircuit,
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
  Timer,
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
const ROOM_SESSION_ID_KEY = "paperclip-battler:room-session-id";
const EMBED_LOBBY_MESSAGE_TYPE = "paperclip-battler:lobby-ready";
const ROOM_SLOT_HEARTBEAT_MS = 4_000;
const DEFAULT_ROOM_ID = "local";
const PLAYER_IDS = ["left", "right"] as const;
const PLAYER_LABELS: Record<PlayerId, string> = {
  left: "Player 1",
  right: "Player 2"
};

async function syncPlayerModeToBridge(baseUrl: string, roomId: string, playerId: PlayerId, mode: PlayerMode) {
  const response = await fetch(`${baseUrl}/players/mode?room=${encodeURIComponent(roomId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ room: roomId, player: playerId, mode })
  });
  if (!response.ok) throw new Error("Bridge rejected player mode sync.");
}

async function syncPlayerModesToBridge(baseUrl: string, roomId: string, modes: Record<PlayerId, PlayerMode>) {
  await Promise.all(PLAYER_IDS.map((playerId) => syncPlayerModeToBridge(baseUrl, roomId, playerId, modes[playerId])));
}
const DEFAULT_PLAYER_MODES: Record<PlayerId, PlayerMode> = {
  left: "human",
  right: "agent"
};

type PlayerId = (typeof PLAYER_IDS)[number];
type PlayerMode = "human" | "agent" | "heuristic" | "both";

type BridgePlayerHealth = {
  id: PlayerId;
  label: string;
  mode: PlayerMode;
  ready: boolean;
  agentEnabled: boolean;
  heuristicEnabled?: boolean;
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

type BridgeRoomParticipant = {
  sessionId?: string;
  sessionSuffix: string;
  role: "player" | "observer";
  player: PlayerId | null;
  joinedAt: number;
  lastSeenAt: number;
  ttlMs: number;
};

type BridgeRoomWarning = {
  kind: "idle" | "max-age";
  message: string;
  action: string | null;
  issuedAt: number;
  closesAt: number;
  ttlMs: number;
};

type BridgeRoom = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  gameStartedAt: number | null;
  completedAt: number | null;
  expiresAt: number | null;
  idleExpiresAt: number | null;
  maxAgeExpiresAt: number | null;
  closesAt: number | null;
  closeReason: string | null;
  warnings: BridgeRoomWarning[];
  ttlMs: number | null;
  elapsedGameMs: number;
  tinyState: Record<string, unknown>;
  roomUrl: string;
  watchUrl: string;
  spectatorCount: number;
  participantCount: number;
  playerCount: number;
  observerCount: number;
  participants: BridgeRoomParticipant[];
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
  gameStartedAt?: number | null;
  elapsedGameMs?: number;
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
  defaultLobby: boolean;
  followDefaultLobby: boolean;
};
type RoomEvent = {
  id: number;
  roomId: string;
  type: string;
  at: number;
  payload?: unknown;
};
type WinnerOverlay = {
  winner: PlayerId;
  message: string;
  nextRoomId: string | null;
  restartDelayMs: number;
  closesAt: number | null;
};

function notifyEmbeddedHost(roomId: string, view: RoomView) {
  if (window.parent === window) return;

  window.parent.postMessage(
    {
      source: "paperclip-battler",
      type: EMBED_LOBBY_MESSAGE_TYPE,
      lobbyId: roomId,
      roomId,
      view,
      url: window.location.href
    },
    "*"
  );
}

function parseGameOverPayload(event: MessageEvent): WinnerOverlay | null {
  try {
    const roomEvent = JSON.parse(event.data) as RoomEvent;
    const payload = roomEvent.payload;
    if (!roomEvent || roomEvent.type !== "game-over" || !isRecordValue(payload)) return null;
    const winner = normalizeWinnerPlayer(payload.winner);
    if (!winner) return null;

    const room = isRecordValue(payload.room) ? payload.room : null;
    const nextRoomId = typeof payload.nextRoomId === "string" ? normalizeRoomId(payload.nextRoomId) : null;
    const restartDelayMs =
      typeof payload.restartDelayMs === "number" && Number.isFinite(payload.restartDelayMs)
        ? Math.max(250, payload.restartDelayMs)
        : 1000;
    const closesAt =
      readTimestamp(payload.closesAt) ??
      readTimestamp(payload.expiresAt) ??
      readTimestamp(room?.expiresAt) ??
      readTimestampFromTtl(payload.ttlMs);

    return {
      winner,
      message: typeof payload.message === "string" ? payload.message : `${PLAYER_LABELS[winner]} wins`,
      nextRoomId,
      restartDelayMs,
      closesAt
    };
  } catch {
    return null;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeWinnerPlayer(value: unknown): PlayerId | null {
  return value === "left" || value === "right" ? value : null;
}

function readTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readTimestampFromTtl(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Date.now() + Math.max(0, value) : null;
}

function shouldResumeDefaultLobby(health: BridgeHealth) {
  const expiresAt = health.room?.expiresAt;
  if (typeof expiresAt === "number" && expiresAt <= Date.now()) return true;

  return !PLAYER_IDS.every((playerId) => {
    const player = health.players?.[playerId];
    const slot = health.room?.slots?.[playerId];
    const mode = player?.mode ?? slot?.mode;
    const ready = player?.ready ?? slot?.ready;
    return mode === "heuristic" && ready;
  });
}

export function App() {
  const initialRoute = readRoomRoute();
  const [bridgeUrl, setBridgeUrl] = useState(() => readInitialBridgeUrl());
  const [roomId, setRoomId] = useState(() =>
    initialRoute.defaultLobby ? DEFAULT_ROOM_ID : initialRoute.roomId ?? localStorage.getItem(ROOM_ID_KEY) ?? DEFAULT_ROOM_ID
  );
  const [roomView, setRoomView] = useState<RoomView>(() => initialRoute.view);
  const [embedded, setEmbedded] = useState(() => initialRoute.embedded);
  const [useDefaultLobby, setUseDefaultLobby] = useState(() => initialRoute.defaultLobby);
  const [followDefaultLobby, setFollowDefaultLobby] = useState(() => initialRoute.followDefaultLobby);
  const [roomNotice, setRoomNotice] = useState("");
  const [playerModes, setPlayerModes] = useState<Record<PlayerId, PlayerMode>>(readPlayerModes);
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [status, setStatus] = useState<BridgeStatus>("checking");
  const [roomParticipant, setRoomParticipant] = useState<BridgeRoomParticipant | null>(null);
  const [winnerOverlay, setWinnerOverlay] = useState<WinnerOverlay | null>(null);
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const importInputRef = useRef<HTMLInputElement>(null);
  const leftFrame = useRef<HTMLIFrameElement>(null);
  const rightFrame = useRef<HTMLIFrameElement>(null);
  const roomSessionIdRef = useRef(readRoomSessionId());
  const lastActivityPostRef = useRef(0);

  const frameRefs: Record<PlayerId, React.RefObject<HTMLIFrameElement>> = {
    left: leftFrame,
    right: rightFrame
  };
  const trimmedBridgeUrl = useMemo(() => bridgeUrl.replace(/\/+$/, ""), [bridgeUrl]);
  const playUrl = `${window.location.origin}/rooms/${encodeURIComponent(roomId)}`;
  const watchUrl = `${window.location.origin}/watch/${encodeURIComponent(roomId)}`;
  const usesRoomSlots = embedded && roomView === "play" && !useDefaultLobby;
  const gameStartedAt = health?.room?.gameStartedAt ?? health?.gameStartedAt ?? null;
  const elapsedGameMs = gameStartedAt ? timerNow - gameStartedAt : health?.room?.elapsedGameMs ?? health?.elapsedGameMs ?? 0;
  const elapsedGameTime = formatElapsedGameTime(elapsedGameMs);
  const gameTimeRunning = Boolean(gameStartedAt);
  const gameTimeTitle = gameStartedAt
    ? `Started ${new Date(gameStartedAt).toLocaleTimeString()}`
    : "Timer starts when both players are ready";
  const lobbyCloseMessage = winnerOverlay?.closesAt
    ? `Lobby will close in ${formatCountdown(winnerOverlay.closesAt - timerNow)}`
    : null;
  const roomWarnings = health?.room?.warnings ?? [];
  const roomWarningClosesAt = roomWarnings[0]?.closesAt ?? null;

  useEffect(() => {
    if (!embedded || useDefaultLobby || !roomId) return;
    notifyEmbeddedHost(roomId, roomView);
  }, [embedded, roomId, roomView, useDefaultLobby]);

  useEffect(() => {
    localStorage.setItem(BRIDGE_URL_KEY, bridgeUrl);
  }, [bridgeUrl]);

  useEffect(() => {
    if (!useDefaultLobby) localStorage.setItem(ROOM_ID_KEY, roomId);
  }, [roomId, useDefaultLobby]);

  useEffect(() => {
    const onPopState = () => {
      const nextRoute = readRoomRoute();
      setRoomId(nextRoute.defaultLobby ? DEFAULT_ROOM_ID : nextRoute.roomId ?? localStorage.getItem(ROOM_ID_KEY) ?? DEFAULT_ROOM_ID);
      setRoomView(nextRoute.view);
      setEmbedded(nextRoute.embedded);
      setUseDefaultLobby(nextRoute.defaultLobby);
      setFollowDefaultLobby(nextRoute.followDefaultLobby);
      setWinnerOverlay(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    localStorage.setItem(PLAYER_MODE_KEY, JSON.stringify(playerModes));
  }, [playerModes]);

  useEffect(() => {
    setTimerNow(Date.now());
    if (!gameStartedAt && !winnerOverlay?.closesAt && !roomWarningClosesAt) return undefined;

    const timer = window.setInterval(() => setTimerNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [gameStartedAt, roomWarningClosesAt, winnerOverlay?.closesAt]);

  async function postRoomActivity(options: { force?: boolean; notice?: boolean } = {}) {
    if (!roomId || useDefaultLobby) return;

    const now = Date.now();
    if (!options.force && now - lastActivityPostRef.current < 15_000) return;
    lastActivityPostRef.current = now;

    try {
      const response = await fetch(`${trimmedBridgeUrl}/rooms/${encodeURIComponent(roomId)}/activity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ at: now })
      });
      if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
      const payload = (await response.json()) as { room?: BridgeRoom };
      if (payload.room?.id === roomId) {
        setHealth((current) => (current ? { ...current, room: payload.room } : current));
      }
      if (options.notice) setRoomNotice("Lobby kept open");
    } catch {
      setStatus("offline");
    }
  }

  useEffect(() => {
    if (!roomId || useDefaultLobby) return undefined;

    const recordActivity = () => {
      void postRoomActivity();
    };
    window.addEventListener("pointerdown", recordActivity, true);
    window.addEventListener("keydown", recordActivity, true);
    window.addEventListener("change", recordActivity, true);
    return () => {
      window.removeEventListener("pointerdown", recordActivity, true);
      window.removeEventListener("keydown", recordActivity, true);
      window.removeEventListener("change", recordActivity, true);
    };
  }, [roomId, trimmedBridgeUrl, useDefaultLobby]);

  async function resolveDefaultLobbyRoute(options: { cancelled?: () => boolean; notice?: string } = {}) {
    setStatus("checking");
    const response = await fetch(`${trimmedBridgeUrl}/lobbies/default`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
    const payload = (await response.json()) as { room?: BridgeRoom };
    if (!payload.room?.id) throw new Error("Bridge did not return a lobby room.");
    if (options.cancelled?.()) return false;

    setRoomId(payload.room.id);
    setRoomView(roomView);
    setUseDefaultLobby(false);
    setFollowDefaultLobby(true);
    setRoomNotice(options.notice ?? `Lobby ${payload.room.id} ready`);
    window.history.replaceState({}, "", roomRoutePath(payload.room.id, roomView, embedded, { followDefaultLobby: true }));
    return true;
  }

  useEffect(() => {
    if (!useDefaultLobby) return undefined;

    let cancelled = false;

    resolveDefaultLobbyRoute({ cancelled: () => cancelled }).catch(() => {
      if (!cancelled) {
        setStatus("offline");
        setRoomNotice("Default lobby offline");
        setUseDefaultLobby(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [embedded, roomView, trimmedBridgeUrl, useDefaultLobby]);

  useEffect(() => {
    if (useDefaultLobby) return undefined;

    let cancelled = false;

    async function syncModes() {
      try {
        if (roomView === "watch") return;
        if (usesRoomSlots) {
          if (roomParticipant?.role !== "player" || !roomParticipant.player) return;
          await syncPlayerModeToBridge(trimmedBridgeUrl, roomId, roomParticipant.player, playerModes[roomParticipant.player]);
        } else {
          await syncPlayerModesToBridge(trimmedBridgeUrl, roomId, playerModes);
        }
      } catch {
        if (!cancelled) setStatus("offline");
      }
    }

    syncModes();
    return () => {
      cancelled = true;
    };
  }, [playerModes, roomId, roomParticipant?.player, roomParticipant?.role, roomView, trimmedBridgeUrl, useDefaultLobby, usesRoomSlots]);

  useEffect(() => {
    if (useDefaultLobby) return undefined;

    let cancelled = false;

    async function pollHealth() {
      try {
        const response = await fetch(`${trimmedBridgeUrl}/health?room=${encodeURIComponent(roomId)}`, { cache: "no-store" });
        if (response.status === 410 && followDefaultLobby) {
          await resolveDefaultLobbyRoute({ cancelled: () => cancelled, notice: "Default lobby resumed" });
          return;
        }
        if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
        let nextHealth = (await response.json()) as BridgeHealth;
        if (followDefaultLobby && shouldResumeDefaultLobby(nextHealth)) {
          await resolveDefaultLobbyRoute({ cancelled: () => cancelled, notice: "Default lobby resumed" });
          return;
        }
        const managedPlayerIds =
          roomView === "watch"
            ? []
            : usesRoomSlots && roomParticipant?.role === "player" && roomParticipant.player
            ? [roomParticipant.player]
            : usesRoomSlots
              ? []
              : [...PLAYER_IDS];
        const bridgeModeMismatch = managedPlayerIds.some((playerId) => nextHealth.players?.[playerId]?.mode !== playerModes[playerId]);
        if (bridgeModeMismatch) {
          await Promise.all(
            managedPlayerIds.map((playerId) => syncPlayerModeToBridge(trimmedBridgeUrl, roomId, playerId, playerModes[playerId]))
          );
          const syncedPlayers: Partial<Record<PlayerId, BridgePlayerHealth>> = { ...(nextHealth.players ?? {}) };
          for (const playerId of managedPlayerIds) {
            const player = syncedPlayers[playerId];
            if (!player) continue;
            const mode = playerModes[playerId];
            syncedPlayers[playerId] = {
              ...player,
              mode,
              agentEnabled: mode === "agent" || mode === "both",
              heuristicEnabled: mode === "heuristic",
              userClicksAllowed: mode === "human" || mode === "both"
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
  }, [
    embedded,
    followDefaultLobby,
    playerModes,
    roomId,
    roomParticipant?.player,
    roomParticipant?.role,
    roomView,
    trimmedBridgeUrl,
    useDefaultLobby,
    usesRoomSlots
  ]);

  useEffect(() => {
    if (!roomId || useDefaultLobby) return undefined;
    let restartTimer: number | null = null;
    const events = new EventSource(`${trimmedBridgeUrl}/rooms/${encodeURIComponent(roomId)}/events`);
    const markConnected = () => setStatus((current) => (current === "offline" ? "checking" : current));
    const handleGameOver = (event: MessageEvent) => {
      const payload = parseGameOverPayload(event);
      if (!payload) return;

      setWinnerOverlay(payload);
      if (!followDefaultLobby || !payload.nextRoomId) return;

      const nextRoomId = payload.nextRoomId;
      restartTimer = window.setTimeout(() => {
        setUseDefaultLobby(false);
        setFollowDefaultLobby(true);
        setRoomId(nextRoomId);
        setRoomView(roomView);
        setWinnerOverlay(null);
        window.history.replaceState({}, "", roomRoutePath(nextRoomId, roomView, embedded, { followDefaultLobby: true }));
      }, payload.restartDelayMs);
    };
    const handleRoomClosed = () => {
      if (!followDefaultLobby) return;
      void resolveDefaultLobbyRoute({ notice: "Default lobby resumed" }).catch(() => setStatus("offline"));
    };
    const handleRoomWarning = (event: MessageEvent) => {
      try {
        const roomEvent = JSON.parse(event.data) as RoomEvent;
        const room = isRecordValue(roomEvent.payload) && isRecordValue(roomEvent.payload.room) ? (roomEvent.payload.room as BridgeRoom) : null;
        if (room?.id === roomId) setHealth((current) => (current ? { ...current, room } : current));
      } catch {
        // The next health poll will refresh room lifecycle warnings.
      }
    };
    events.addEventListener("snapshot", markConnected);
    events.addEventListener("room", markConnected);
    events.addEventListener("game-over", handleGameOver);
    events.addEventListener("room-warning", handleRoomWarning);
    events.addEventListener("room-closed", handleRoomClosed);
    events.onerror = () => events.close();
    return () => {
      if (restartTimer !== null) window.clearTimeout(restartTimer);
      events.close();
    };
  }, [embedded, followDefaultLobby, roomId, roomView, trimmedBridgeUrl, useDefaultLobby]);

  useEffect(() => {
    setWinnerOverlay(null);
  }, [roomId]);

  useEffect(() => {
    if (!usesRoomSlots || !roomId) {
      setRoomParticipant(null);
      return undefined;
    }

    let cancelled = false;
    async function postParticipant(path: "participants" | "participants/heartbeat") {
      const response = await fetch(`${trimmedBridgeUrl}/rooms/${encodeURIComponent(roomId)}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: roomSessionIdRef.current })
      });
      if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
      const payload = (await response.json()) as { participant?: BridgeRoomParticipant };
      if (!cancelled && payload.participant) {
        if (payload.participant.sessionId && payload.participant.sessionId !== roomSessionIdRef.current) {
          roomSessionIdRef.current = payload.participant.sessionId;
          sessionStorage.setItem(ROOM_SESSION_ID_KEY, payload.participant.sessionId);
        }
        setRoomParticipant(payload.participant);
        setStatus("connected");
      }
    }

    const leaveParticipant = () => {
      const body = JSON.stringify({ sessionId: roomSessionIdRef.current });
      const url = `${trimmedBridgeUrl}/rooms/${encodeURIComponent(roomId)}/participants/leave`;
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        return;
      }
      void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true
      }).catch(() => undefined);
    };

    postParticipant("participants").catch(() => {
      if (!cancelled) setStatus("offline");
    });
    const timer = window.setInterval(() => {
      postParticipant("participants/heartbeat").catch(() => {
        if (!cancelled) setStatus("offline");
      });
    }, ROOM_SLOT_HEARTBEAT_MS);

    window.addEventListener("pagehide", leaveParticipant);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("pagehide", leaveParticipant);
      leaveParticipant();
    };
  }, [roomId, trimmedBridgeUrl, usesRoomSlots]);

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
      const payload = (await response.json()) as Pick<BridgeHealth, "allPlayersReady" | "players" | "room">;
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
            agentEnabled: mode === "agent" || mode === "both",
            heuristicEnabled: mode === "heuristic",
            userClicksAllowed: mode === "human" || mode === "both"
          }
        }
      };
    });
  }

  function navigateRoom(nextRoomId: string, nextView: RoomView, options: { replace?: boolean } = {}) {
    const normalized = normalizeRoomId(nextRoomId);
    setUseDefaultLobby(false);
    setFollowDefaultLobby(false);
    setWinnerOverlay(null);
    setRoomId(normalized);
    setRoomView(nextView);
    const nextPath = roomRoutePath(normalized, nextView, embedded);
    if (options.replace) {
      window.history.replaceState({}, "", nextPath);
    } else {
      window.history.pushState({}, "", nextPath);
    }
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

  const assignedPlayer = usesRoomSlots && roomParticipant?.role === "player" ? roomParticipant.player : null;
  const observerMode = usesRoomSlots && roomParticipant?.role === "observer";
  const waitingForSlot = usesRoomSlots && !roomParticipant;

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

      <section className="room-body">
        {roomWarnings.length ? (
          <RoomWarningBanner warnings={roomWarnings} now={timerNow} onKeepOpen={() => postRoomActivity({ force: true, notice: true })} />
        ) : null}

        {useDefaultLobby ? (
          <LobbyStatusView message={status === "offline" ? "Default lobby offline" : "Finding lobby"} />
        ) : waitingForSlot ? (
          <LobbyStatusView message={status === "offline" ? "Room bridge offline" : "Joining lobby"} />
        ) : roomView === "watch" || observerMode ? (
          <WatchView
            health={health}
            status={status}
            playerModes={playerModes}
            sourceForPlayer={spectatorUrl}
            winnerOverlay={winnerOverlay}
            lobbyCloseMessage={lobbyCloseMessage}
            elapsedGameTime={elapsedGameTime}
            gameTimeRunning={gameTimeRunning}
            gameTimeTitle={gameTimeTitle}
          />
        ) : assignedPlayer ? (
          <section className="split-view">
            {PLAYER_IDS.map((playerId) => {
              const isAssignedPlayer = playerId === assignedPlayer;
              const noop = () => undefined;
              return (
                <OriginalPane
                  key={playerId}
                  title={isAssignedPlayer ? `${PLAYER_LABELS[playerId]} (you)` : PLAYER_LABELS[playerId]}
                  source={isAssignedPlayer ? playerUrl(playerId) : spectatorUrl(playerId)}
                  mode={isAssignedPlayer ? playerModes[playerId] : health?.players?.[playerId]?.mode ?? playerModes[playerId]}
                  health={health?.players?.[playerId]}
                  frameRef={isAssignedPlayer ? frameRefs[playerId] : undefined}
                  disabled={status === "offline"}
                  allPlayersReady={Boolean(health?.allPlayersReady)}
                  elapsedGameTime={elapsedGameTime}
                  gameTimeRunning={gameTimeRunning}
                  gameTimeTitle={gameTimeTitle}
                  readOnly={!isAssignedPlayer}
                  onModeChange={isAssignedPlayer ? (mode) => setPlayerMode(playerId, mode) : noop}
                  onReadyChange={isAssignedPlayer ? (ready) => setPlayerReady(playerId, ready) : noop}
                  onReload={isAssignedPlayer ? () => reloadPlayer(playerId) : noop}
                  onReset={isAssignedPlayer ? () => resetPlayer(playerId) : noop}
                  onReleaseClaim={isAssignedPlayer ? () => releasePlayerClaim(playerId) : noop}
                  winnerMessage={winnerOverlay?.winner === playerId ? winnerOverlay.message : null}
                  winnerCloseMessage={winnerOverlay?.winner === playerId ? lobbyCloseMessage : null}
                />
              );
            })}
          </section>
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
                elapsedGameTime={elapsedGameTime}
                gameTimeRunning={gameTimeRunning}
                gameTimeTitle={gameTimeTitle}
                onModeChange={(mode) => setPlayerMode(playerId, mode)}
                onReadyChange={(ready) => setPlayerReady(playerId, ready)}
                onReload={() => reloadPlayer(playerId)}
                onReset={() => resetPlayer(playerId)}
                onReleaseClaim={() => releasePlayerClaim(playerId)}
                winnerMessage={winnerOverlay?.winner === playerId ? winnerOverlay.message : null}
                winnerCloseMessage={winnerOverlay?.winner === playerId ? lobbyCloseMessage : null}
              />
            ))}
          </section>
        )}
      </section>
    </main>
  );
}

function WatchView({
  health,
  status,
  playerModes,
  sourceForPlayer,
  winnerOverlay,
  lobbyCloseMessage,
  elapsedGameTime,
  gameTimeRunning,
  gameTimeTitle
}: {
  health: BridgeHealth | null;
  status: BridgeStatus;
  playerModes: Record<PlayerId, PlayerMode>;
  sourceForPlayer: (playerId: PlayerId) => string;
  winnerOverlay: WinnerOverlay | null;
  lobbyCloseMessage: string | null;
  elapsedGameTime: string;
  gameTimeRunning: boolean;
  gameTimeTitle: string;
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
          elapsedGameTime={elapsedGameTime}
          gameTimeRunning={gameTimeRunning}
          gameTimeTitle={gameTimeTitle}
          readOnly
          onModeChange={noop}
          onReadyChange={noop}
          onReload={noop}
          onReset={noop}
          onReleaseClaim={noop}
          winnerMessage={winnerOverlay?.winner === playerId ? winnerOverlay.message : null}
          winnerCloseMessage={winnerOverlay?.winner === playerId ? lobbyCloseMessage : null}
        />
      ))}
    </section>
  );
}

function LobbyStatusView({ message }: { message: string }) {
  return (
    <section className="lobby-status" role="status" aria-live="polite">
      <div>
        <Users size={18} />
        <span>{message}</span>
      </div>
    </section>
  );
}

function RoomWarningBanner({
  warnings,
  now,
  onKeepOpen
}: {
  warnings: BridgeRoomWarning[];
  now: number;
  onKeepOpen: () => void;
}) {
  return (
    <div className="room-warning-bar" role="status" aria-live="polite">
      {warnings.map((warning) => (
        <div key={warning.kind} className={`room-warning ${warning.kind}`}>
          <Timer size={17} />
          <span>
            {warning.message} Closes in {formatCountdown(warning.closesAt - now)}.
          </span>
          {warning.kind === "idle" ? (
            <button type="button" onClick={onKeepOpen}>
              Keep open
            </button>
          ) : null}
        </div>
      ))}
    </div>
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
  elapsedGameTime,
  gameTimeRunning,
  gameTimeTitle,
  onModeChange,
  onReadyChange,
  onReload,
  onReset,
  onReleaseClaim,
  winnerMessage,
  winnerCloseMessage,
  readOnly = false
}: {
  title: string;
  source: string;
  mode: PlayerMode;
  health?: BridgePlayerHealth;
  frameRef?: React.RefObject<HTMLIFrameElement>;
  disabled: boolean;
  allPlayersReady: boolean;
  elapsedGameTime: string;
  gameTimeRunning: boolean;
  gameTimeTitle: string;
  onModeChange: (mode: PlayerMode) => void;
  onReadyChange: (ready: boolean) => void;
  onReload: () => void;
  onReset: () => void;
  onReleaseClaim: () => void;
  winnerMessage?: string | null;
  winnerCloseMessage?: string | null;
  readOnly?: boolean;
}) {
  const connected = Boolean(health?.connected);
  const buttonCount = health?.buttonCount ?? 0;
  const claim = health?.claim ?? null;
  const ready = Boolean(health?.ready);
  const readyLocked = mode === "agent";
  const mouseLocked = mode === "agent" || mode === "heuristic";
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
          <span className={`time-badge ${gameTimeRunning ? "running" : "waiting"}`} title={gameTimeTitle}>
            <Timer size={14} />
            {elapsedGameTime}
          </span>
          {!allPlayersReady ? (
            <span className="agent-badge gate" title="Both players must be ready first.">
              <Lock size={14} />
              Input held
            </span>
          ) : null}
          {mode !== "human" ? (
            <span className={`agent-badge ${connected ? "online" : "waiting"}`}>
              {mode === "heuristic" ? <BrainCircuit size={14} /> : <Server size={14} />}
              {buttonCount} buttons
            </span>
          ) : null}
          {mouseLocked ? (
            <span className="agent-badge locked">
              <Lock size={14} />
              {mode === "heuristic" ? "AI control" : "Mouse locked"}
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
      {winnerMessage ? (
        <div className="winner-overlay" role="status" aria-live="polite">
          <div className="winner-overlay-content">
            <span>{winnerMessage}</span>
            {winnerCloseMessage ? <small>{winnerCloseMessage}</small> : null}
          </div>
        </div>
      ) : null}
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
      {(["human", "agent", "heuristic", "both"] as PlayerMode[]).map((option) => (
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
  const followDefaultLobby = shouldFollowDefaultLobby();
  const defaultLobby = shouldUseDefaultLobby(queryRoom);
  const embedMatch = window.location.pathname.match(/^\/embed(?:\/(rooms|watch))?\/([^/]+)/);
  if (embedMatch) {
    return {
      roomId: normalizeRoomId(decodeURIComponent(embedMatch[2])),
      view: embedMatch[1] === "watch" ? "watch" : "play",
      embedded: true,
      defaultLobby: false,
      followDefaultLobby
    };
  }

  const match = window.location.pathname.match(/^\/(rooms|watch)\/([^/]+)/);
  if (!match) {
    return {
      roomId: defaultLobby ? null : queryRoom,
      view: defaultLobby ? queryDefaultLobbyView() : queryView(),
      embedded,
      defaultLobby,
      followDefaultLobby: defaultLobby || followDefaultLobby
    };
  }

  return {
    roomId: normalizeRoomId(decodeURIComponent(match[2])),
    view: match[1] === "watch" ? "watch" : "play",
    embedded,
    defaultLobby: false,
    followDefaultLobby
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

function shouldUseDefaultLobby(queryRoom: string | null) {
  if (queryRoom) return false;
  if (shouldFollowDefaultLobby()) return true;
  return window.location.pathname === "/embed" || window.location.pathname === "/embed/";
}

function shouldFollowDefaultLobby() {
  const params = new URLSearchParams(window.location.search);
  const lobby = params.get("lobby")?.trim().toLowerCase();
  const defaultLobby = params.get("defaultLobby")?.trim().toLowerCase();
  if (lobby === "default" || defaultLobby === "1" || defaultLobby === "true") return true;
  return false;
}

function getQueryRoomId() {
  const room = new URLSearchParams(window.location.search).get("room");
  return room ? normalizeRoomId(room) : null;
}

function queryView(): RoomView {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "watch" ? "watch" : "play";
}

function queryDefaultLobbyView(): RoomView {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "play" ? "play" : "watch";
}

function roomRoutePath(roomId: string, view: RoomView, embedded: boolean, options: { followDefaultLobby?: boolean } = {}) {
  const encodedRoom = encodeURIComponent(roomId);
  const path = embedded
    ? view === "watch"
      ? `/embed/watch/${encodedRoom}`
      : `/embed/${encodedRoom}`
    : `${view === "watch" ? "/watch" : "/rooms"}/${encodedRoom}`;
  return options.followDefaultLobby ? `${path}?defaultLobby=1` : path;
}

function normalizeRoomId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32) || DEFAULT_ROOM_ID;
}

function readRoomSessionId() {
  const saved = sessionStorage.getItem(ROOM_SESSION_ID_KEY);
  if (saved && /^[A-Za-z0-9_-]{8,96}$/.test(saved)) return saved;
  const next = createRoomSessionId();
  sessionStorage.setItem(ROOM_SESSION_ID_KEY, next);
  return next;
}

function createRoomSessionId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
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
  return value === "human" || value === "agent" || value === "heuristic" || value === "both";
}

function modeLabel(mode: PlayerMode) {
  if (mode === "agent") return "Agent";
  if (mode === "heuristic") return "Heuristic";
  if (mode === "both") return "Both";
  return "Human";
}

function modeTitle(mode: PlayerMode) {
  if (mode === "agent") return "MCP only";
  if (mode === "heuristic") return "Built-in heuristic AI";
  if (mode === "both") return "Human and MCP";
  return "Human only";
}

function modeIcon(mode: PlayerMode) {
  if (mode === "agent") return <Bot size={14} />;
  if (mode === "heuristic") return <BrainCircuit size={14} />;
  if (mode === "both") return <Users size={14} />;
  return <User size={14} />;
}

function formatElapsedGameTime(elapsedMs: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }

  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function formatCountdown(ttlMs: number) {
  const totalSeconds = Math.max(0, Math.ceil(ttlMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatTtl(ttlMs: number) {
  const seconds = Math.max(0, Math.ceil(ttlMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}
