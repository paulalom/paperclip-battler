import {
  Bot,
  Brain,
  Cpu,
  DollarSign,
  ExternalLink,
  Factory,
  Minus,
  Paperclip,
  Plus,
  RefreshCcw,
  RotateCcw,
  ShoppingCart,
  Sparkles,
  Zap
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ACTION_LABELS,
  ActionAvailability,
  GameAction,
  GameSnapshot,
  GameState,
  UPGRADES,
  advanceGame,
  applyAction,
  chooseDemoAgentAction,
  createGame,
  deriveGame,
  formatCost,
  formatNumber,
  snapshotGame
} from "./game";

const HUMAN_KEY = "paperclip-battler:human";
const AGENT_KEY = "paperclip-battler:agent-local";
const BRIDGE_URL_KEY = "paperclip-battler:bridge-url";

type BridgeStatus = "checking" | "connected" | "offline";

export function App() {
  const [now, setNow] = useState(() => Date.now());
  const [human, setHuman] = useStoredGame(HUMAN_KEY, () => createGame("Player", "player"));
  const [localAgent, setLocalAgent] = useStoredGame(AGENT_KEY, () => createGame("Agent", "agent"));
  const [bridgeUrl, setBridgeUrl] = useState(() => localStorage.getItem(BRIDGE_URL_KEY) ?? "http://127.0.0.1:8787");
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("checking");
  const [bridgeSnapshot, setBridgeSnapshot] = useState<GameSnapshot | null>(null);
  const [demoBot, setDemoBot] = useState(true);

  const bridgeConnected = bridgeStatus === "connected" && bridgeSnapshot !== null;

  useEffect(() => {
    localStorage.setItem(BRIDGE_URL_KEY, bridgeUrl);
  }, [bridgeUrl]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const tickAt = Date.now();
      setNow(tickAt);
      setHuman((state) => advanceGame(state, tickAt));
      if (!bridgeConnected) {
        setLocalAgent((state) => advanceGame(state, tickAt));
      }
    }, 250);

    return () => window.clearInterval(timer);
  }, [bridgeConnected, setHuman, setLocalAgent]);

  useEffect(() => {
    if (bridgeConnected || !demoBot) return undefined;

    const timer = window.setInterval(() => {
      setLocalAgent((state) => {
        const action = chooseDemoAgentAction(state);
        return applyAction(state, action, Date.now()).state;
      });
    }, 900);

    return () => window.clearInterval(timer);
  }, [bridgeConnected, demoBot, setLocalAgent]);

  useEffect(() => {
    let cancelled = false;

    async function pollBridge() {
      try {
        const response = await fetch(`${trimUrl(bridgeUrl)}/state`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Bridge returned ${response.status}`);
        const payload = (await response.json()) as GameSnapshot;
        if (!cancelled) {
          setBridgeSnapshot(payload);
          setBridgeStatus("connected");
        }
      } catch {
        if (!cancelled) {
          setBridgeStatus("offline");
          setBridgeSnapshot(null);
        }
      }
    }

    setBridgeStatus("checking");
    pollBridge();
    const timer = window.setInterval(pollBridge, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [bridgeUrl]);

  const humanSnapshot = useMemo(() => snapshotGame(human, now), [human, now]);
  const localAgentSnapshot = useMemo(() => snapshotGame(localAgent, now), [localAgent, now]);
  const agentSnapshot = bridgeSnapshot ?? localAgentSnapshot;

  function dispatchHuman(action: GameAction) {
    setHuman((state) => applyAction(state, action, Date.now()).state);
  }

  async function dispatchAgent(action: GameAction) {
    if (!bridgeConnected) {
      setLocalAgent((state) => applyAction(state, action, Date.now()).state);
      return;
    }

    const response = await fetch(`${trimUrl(bridgeUrl)}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    if (!response.ok) {
      setBridgeStatus("offline");
      return;
    }
    const payload = (await response.json()) as { snapshot: GameSnapshot };
    setBridgeSnapshot(payload.snapshot);
  }

  async function resetAgent() {
    if (!bridgeConnected) {
      setLocalAgent(createGame("Agent", "agent"));
      return;
    }

    const response = await fetch(`${trimUrl(bridgeUrl)}/reset`, { method: "POST" });
    if (response.ok) {
      const payload = (await response.json()) as { snapshot: GameSnapshot };
      setBridgeSnapshot(payload.snapshot);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">
            <Paperclip size={25} strokeWidth={2.4} />
          </div>
          <div>
            <h1>Paperclip Battler</h1>
            <a href="https://www.decisionproblem.com/paperclips/index2.html" target="_blank" rel="noreferrer">
              Original Universal Paperclips <ExternalLink size={13} />
            </a>
          </div>
        </div>

        <div className="bridge-bar" aria-label="MCP bridge">
          <span className={`status-pill ${bridgeStatus}`}>{bridgeLabel(bridgeStatus)}</span>
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

      <section className="arena">
        <GamePanel
          snapshot={humanSnapshot}
          title="Player"
          variant="human"
          onAction={dispatchHuman}
          onReset={() => setHuman(createGame("Player", "player"))}
        />
        <GamePanel
          snapshot={agentSnapshot}
          title={bridgeConnected ? "Agent via MCP" : "Agent Demo"}
          variant="agent"
          onAction={dispatchAgent}
          onReset={resetAgent}
          footer={
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={demoBot}
                onChange={(event) => setDemoBot(event.target.checked)}
                disabled={bridgeConnected}
              />
              <span>Demo bot</span>
            </label>
          }
        />
      </section>
    </main>
  );
}

function GamePanel({
  snapshot,
  title,
  variant,
  onAction,
  onReset,
  footer
}: {
  snapshot: GameSnapshot;
  title: string;
  variant: "human" | "agent";
  onAction: (action: GameAction) => void;
  onReset: () => void;
  footer?: React.ReactNode;
}) {
  const { state, derived, actions } = snapshot;
  const actionMap = new Map(actions.map((action) => [action.action, action]));
  const upgradeRows = UPGRADES.map((upgrade) => ({
    ...upgrade,
    availability: actionMap.get(upgrade.action)
  }));

  return (
    <article className={`game-panel ${variant}`}>
      <div className="panel-title">
        <div>
          <span>{title}</span>
          <strong>{formatNumber(state.totalPaperclips)} clips</strong>
        </div>
        <button className="icon-button" onClick={onReset} title={`Reset ${title}`}>
          <RotateCcw size={17} />
        </button>
      </div>

      <div className="primary-readout">
        <div>
          <span>Total Paperclips</span>
          <strong>{formatNumber(state.totalPaperclips)}</strong>
        </div>
        <div className="clip-stream" aria-hidden="true">
          <Paperclip size={32} />
          <Paperclip size={23} />
          <Paperclip size={18} />
        </div>
      </div>

      <div className="metric-grid">
        <Metric icon={<Factory size={16} />} label="CPS" value={formatNumber(derived.clipsPerSecond)} />
        <Metric icon={<ShoppingCart size={16} />} label="Inventory" value={formatNumber(state.paperclips)} />
        <Metric icon={<Zap size={16} />} label="Wire" value={formatNumber(state.wire)} />
        <Metric icon={<DollarSign size={16} />} label="Funds" value={`$${formatNumber(state.funds)}`} />
        <Metric icon={<Sparkles size={16} />} label="Demand" value={`${Math.round(derived.demand * 100)}%`} />
        <Metric icon={<Brain size={16} />} label="Yomi" value={formatNumber(state.yomi)} />
      </div>

      <div className="control-band make-band">
        <ActionButton action={actionMap.get("make_paperclip")} onClick={onAction} icon={<Paperclip size={16} />} large />
        <div className="price-cluster" aria-label="Price controls">
          <button onClick={() => onAction("lower_price")} title={ACTION_LABELS.lower_price}>
            <Minus size={16} />
          </button>
          <span>${state.price.toFixed(2)}</span>
          <button onClick={() => onAction("raise_price")} title={ACTION_LABELS.raise_price}>
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="section-grid">
        <section className="tool-section">
          <h2>Business</h2>
          <ActionButton action={actionMap.get("buy_marketing")} onClick={onAction} icon={<Sparkles size={16} />}>
            ${formatNumber(derived.marketingCost)}
          </ActionButton>
          <div className="subline">Level {state.marketingLevel}</div>
        </section>

        <section className="tool-section">
          <h2>Manufacturing</h2>
          <ActionButton action={actionMap.get("buy_wire")} onClick={onAction} icon={<Zap size={16} />}>
            ${formatNumber(derived.wireCost)}
          </ActionButton>
          <ActionButton action={actionMap.get("buy_auto_clipper")} onClick={onAction} icon={<Factory size={16} />}>
            ${formatNumber(derived.autoClipperCost)}
          </ActionButton>
          <ActionButton action={actionMap.get("buy_mega_clipper")} onClick={onAction} icon={<Factory size={16} />}>
            ${formatNumber(derived.megaClipperCost)}
          </ActionButton>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={state.autoWireBuyer}
              onChange={() => onAction("toggle_wire_buyer")}
            />
            <span>Wire buyer</span>
          </label>
          <div className="subline">
            {state.autoClippers} auto / {state.megaClippers} mega
          </div>
        </section>

        <section className="tool-section">
          <h2>Compute</h2>
          <div className="trust-row">
            <span>Trust {derived.trust}</span>
            <span>{derived.availableTrust} free</span>
          </div>
          <div className="progress-track">
            <span style={{ width: `${Math.min(100, (state.operations / derived.operationCapacity) * 100)}%` }} />
          </div>
          <ActionButton action={actionMap.get("add_processor")} onClick={onAction} icon={<Cpu size={16} />} />
          <ActionButton action={actionMap.get("add_memory")} onClick={onAction} icon={<Brain size={16} />} />
          <ActionButton action={actionMap.get("run_tournament")} onClick={onAction} icon={<Bot size={16} />} />
          <div className="subline">
            {formatNumber(state.operations)} / {formatNumber(derived.operationCapacity)} ops
          </div>
        </section>

        <section className="tool-section">
          <h2>Projects</h2>
          {upgradeRows.map((upgrade) => (
            <button
              className="upgrade-row"
              key={upgrade.id}
              onClick={() => onAction(upgrade.action)}
              disabled={!upgrade.availability?.available}
              title={upgrade.note}
            >
              <span>{upgrade.name}</span>
              <small>{state.upgrades.includes(upgrade.id) ? "Installed" : formatCost(upgrade.cost)}</small>
            </button>
          ))}
        </section>
      </div>

      <div className="event-log" aria-label={`${title} event log`}>
        {state.log.slice(0, 4).map((event) => (
          <span key={`${event.at}:${event.text}`}>{event.text}</span>
        ))}
      </div>

      {footer ? <div className="panel-footer">{footer}</div> : null}
    </article>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ActionButton({
  action,
  onClick,
  icon,
  large = false,
  children
}: {
  action?: ActionAvailability;
  onClick: (action: GameAction) => void;
  icon: React.ReactNode;
  large?: boolean;
  children?: React.ReactNode;
}) {
  if (!action) return null;

  return (
    <button
      className={`action-button ${large ? "large" : ""}`}
      onClick={() => onClick(action.action)}
      disabled={!action.available}
      title={action.available ? action.label : action.reason}
    >
      {icon}
      <span>{action.label}</span>
      {children ? <small>{children}</small> : null}
    </button>
  );
}

function useStoredGame(key: string, create: () => GameState) {
  const [state, setState] = useState<GameState>(() => {
    const stored = localStorage.getItem(key);
    if (!stored) return create();

    try {
      return reviveGame(JSON.parse(stored) as Partial<GameState>, create);
    } catch {
      return create();
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);

  return [state, setState] as const;
}

function reviveGame(value: Partial<GameState>, create: () => GameState): GameState {
  const fresh = create();
  const merged = { ...fresh, ...value };
  return {
    ...merged,
    upgrades: Array.isArray(value.upgrades) ? value.upgrades : fresh.upgrades,
    log: Array.isArray(value.log) ? value.log : fresh.log,
    lastTickAt: typeof value.lastTickAt === "number" ? value.lastTickAt : Date.now(),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now()
  };
}

function trimUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function bridgeLabel(status: BridgeStatus) {
  if (status === "connected") return "MCP connected";
  if (status === "checking") return "MCP checking";
  return "MCP offline";
}
