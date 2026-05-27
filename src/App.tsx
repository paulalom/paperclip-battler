import { ExternalLink, RefreshCcw, RotateCcw, Server, SplitSquareVertical } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const ORIGINAL_URL = "https://www.decisionproblem.com/paperclips/index2.html";
const BRIDGE_URL_KEY = "paperclip-battler:bridge-url";

type BridgeHealth = {
  ok: boolean;
  bridgeUrl: string;
  agentUrl: string;
  agentConnected: boolean;
  lastReportAt: number | null;
  buttonCount: number;
};

type BridgeStatus = "checking" | "connected" | "offline";

export function App() {
  const [bridgeUrl, setBridgeUrl] = useState(() => localStorage.getItem(BRIDGE_URL_KEY) ?? "http://127.0.0.1:8787");
  const [health, setHealth] = useState<BridgeHealth | null>(null);
  const [status, setStatus] = useState<BridgeStatus>("checking");
  const playerFrame = useRef<HTMLIFrameElement>(null);
  const agentFrame = useRef<HTMLIFrameElement>(null);

  const trimmedBridgeUrl = useMemo(() => bridgeUrl.replace(/\/+$/, ""), [bridgeUrl]);
  const agentUrl = `${trimmedBridgeUrl}/agent/index2.html`;

  useEffect(() => {
    localStorage.setItem(BRIDGE_URL_KEY, bridgeUrl);
  }, [bridgeUrl]);

  useEffect(() => {
    let cancelled = false;

    async function pollHealth() {
      try {
        const response = await fetch(`${trimmedBridgeUrl}/health`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
        const nextHealth = (await response.json()) as BridgeHealth;
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
  }, [trimmedBridgeUrl]);

  function reloadPlayer() {
    if (playerFrame.current) {
      playerFrame.current.src = ORIGINAL_URL;
    }
  }

  async function resetAgent() {
    try {
      await fetch(`${trimmedBridgeUrl}/agent-control/manual-reset`, { method: "POST" });
    } finally {
      if (agentFrame.current) {
        agentFrame.current.src = `${agentUrl}?reset=${Date.now()}`;
      }
    }
  }

  return (
    <main className="app-shell">
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
      </header>

      <section className="split-view">
        <OriginalPane
          title="Player"
          source={ORIGINAL_URL}
          frameRef={playerFrame}
          actions={
            <button className="icon-button" onClick={reloadPlayer} title="Reload player pane">
              <RefreshCcw size={16} />
            </button>
          }
        />
        <OriginalPane
          title="Agent"
          source={agentUrl}
          frameRef={agentFrame}
          badge={
            <span className={`agent-badge ${health?.agentConnected ? "online" : "waiting"}`}>
              <Server size={14} />
              {health?.buttonCount ?? 0} buttons
            </span>
          }
          actions={
            <button className="icon-button" onClick={resetAgent} title="Reset agent pane">
              <RotateCcw size={16} />
            </button>
          }
        />
      </section>
    </main>
  );
}

function OriginalPane({
  title,
  source,
  frameRef,
  badge,
  actions
}: {
  title: string;
  source: string;
  frameRef: React.RefObject<HTMLIFrameElement>;
  badge?: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <article className="pane">
      <div className="pane-toolbar">
        <div>
          <span>{title}</span>
          {badge}
        </div>
        <div className="pane-actions">{actions}</div>
      </div>
      <iframe ref={frameRef} src={source} title={`${title} Universal Paperclips`} />
    </article>
  );
}

function bridgeLabel(status: BridgeStatus, health: BridgeHealth | null) {
  if (status === "checking") return "MCP checking";
  if (status === "offline") return "MCP offline";
  return health?.agentConnected ? "MCP connected" : "MCP waiting";
}
