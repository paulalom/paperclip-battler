export const GAME_ACTIONS = [
  "make_paperclip",
  "lower_price",
  "raise_price",
  "buy_wire",
  "toggle_wire_buyer",
  "buy_auto_clipper",
  "buy_mega_clipper",
  "buy_marketing",
  "add_processor",
  "add_memory",
  "run_tournament",
  "buy_upgrade_efficient_clippers",
  "buy_upgrade_wire_saver",
  "buy_upgrade_market_forecaster",
  "buy_upgrade_parallel_processors",
  "buy_upgrade_tournament_engine",
  "wait"
] as const;

export type GameAction = (typeof GAME_ACTIONS)[number];

export type UpgradeId =
  | "efficient_clippers"
  | "wire_saver"
  | "market_forecaster"
  | "parallel_processors"
  | "tournament_engine";

export type ResourceCost = Partial<{
  funds: number;
  operations: number;
  creativity: number;
  yomi: number;
}>;

export type UpgradeDefinition = {
  id: UpgradeId;
  action: GameAction;
  name: string;
  note: string;
  cost: ResourceCost;
};

export type GameEvent = {
  at: number;
  text: string;
};

export type GameState = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastTickAt: number;
  paperclips: number;
  totalPaperclips: number;
  wire: number;
  wirePrice: number;
  funds: number;
  price: number;
  marketingLevel: number;
  autoClippers: number;
  megaClippers: number;
  processors: number;
  memory: number;
  operations: number;
  creativity: number;
  yomi: number;
  autoWireBuyer: boolean;
  upgrades: UpgradeId[];
  marketSeed: number;
  log: GameEvent[];
};

export type DerivedGameState = {
  clipsPerSecond: number;
  clipsSoldPerSecond: number;
  demand: number;
  trust: number;
  nextTrustAt: number | null;
  availableTrust: number;
  operationCapacity: number;
  operationsPerSecond: number;
  creativityPerSecond: number;
  wirePerClip: number;
  autoClipperCost: number;
  megaClipperCost: number;
  marketingCost: number;
  wireCost: number;
  valuation: number;
};

export type ActionAvailability = {
  action: GameAction;
  label: string;
  available: boolean;
  reason?: string;
};

export type GameSnapshot = {
  state: GameState;
  derived: DerivedGameState;
  actions: ActionAvailability[];
};

const TRUST_THRESHOLDS = [
  1_000,
  2_000,
  5_000,
  10_000,
  25_000,
  50_000,
  100_000,
  250_000,
  500_000,
  1_000_000,
  2_500_000,
  5_000_000,
  10_000_000
];

export const ACTION_LABELS: Record<GameAction, string> = {
  make_paperclip: "Make Paperclip",
  lower_price: "Lower Price",
  raise_price: "Raise Price",
  buy_wire: "Buy Wire",
  toggle_wire_buyer: "Wire Buyer",
  buy_auto_clipper: "AutoClipper",
  buy_mega_clipper: "MegaClipper",
  buy_marketing: "Marketing",
  add_processor: "Processor",
  add_memory: "Memory",
  run_tournament: "Tournament",
  buy_upgrade_efficient_clippers: "Efficient Clippers",
  buy_upgrade_wire_saver: "Wire Saver",
  buy_upgrade_market_forecaster: "Market Forecaster",
  buy_upgrade_parallel_processors: "Parallel Processors",
  buy_upgrade_tournament_engine: "Tournament Engine",
  wait: "Wait"
};

export const UPGRADES: UpgradeDefinition[] = [
  {
    id: "efficient_clippers",
    action: "buy_upgrade_efficient_clippers",
    name: "Efficient Clippers",
    note: "+25% automatic production",
    cost: { operations: 750 }
  },
  {
    id: "wire_saver",
    action: "buy_upgrade_wire_saver",
    name: "Wire Saver",
    note: "Paperclips consume 20% less wire",
    cost: { operations: 1_200, yomi: 20 }
  },
  {
    id: "market_forecaster",
    action: "buy_upgrade_market_forecaster",
    name: "Market Forecaster",
    note: "+30% demand at every price",
    cost: { creativity: 25 }
  },
  {
    id: "parallel_processors",
    action: "buy_upgrade_parallel_processors",
    name: "Parallel Processors",
    note: "+50% operations per second",
    cost: { operations: 2_500, creativity: 50 }
  },
  {
    id: "tournament_engine",
    action: "buy_upgrade_tournament_engine",
    name: "Tournament Engine",
    note: "+50% yomi from tournaments",
    cost: { yomi: 100 }
  }
];

export function createGame(name: string, id = slugify(name), now = Date.now()): GameState {
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    lastTickAt: now,
    paperclips: 0,
    totalPaperclips: 0,
    wire: 1_000,
    wirePrice: 20,
    funds: 0,
    price: 0.25,
    marketingLevel: 1,
    autoClippers: 0,
    megaClippers: 0,
    processors: 1,
    memory: 1,
    operations: 0,
    creativity: 0,
    yomi: 0,
    autoWireBuyer: false,
    upgrades: [],
    marketSeed: Math.abs(hashString(`${name}:${now}`)),
    log: [{ at: now, text: `${name} game started.` }]
  };
}

export function snapshotGame(state: GameState, now = Date.now()): GameSnapshot {
  const advanced = advanceGame(state, now);
  return {
    state: advanced,
    derived: deriveGame(advanced),
    actions: listAvailableActions(advanced)
  };
}

export function deriveGame(state: GameState): DerivedGameState {
  const efficientClippers = hasUpgrade(state, "efficient_clippers") ? 1.25 : 1;
  const wirePerClip = hasUpgrade(state, "wire_saver") ? 0.8 : 1;
  const demandBoost = hasUpgrade(state, "market_forecaster") ? 1.3 : 1;
  const processorBoost = hasUpgrade(state, "parallel_processors") ? 1.5 : 1;
  const clipsPerSecond =
    (state.autoClippers * 0.22 + state.megaClippers * 8) * efficientClippers;
  const pricePressure = Math.max(0.12, state.price / 0.25);
  const demand = clamp(
    ((0.12 + state.marketingLevel * 0.075) * demandBoost) / Math.pow(pricePressure, 1.16),
    0.01,
    1.35
  );
  const clipsSoldPerSecond = demand * (5 + state.marketingLevel * 1.15);
  const trust = calculateTrust(state.totalPaperclips);
  const nextTrustAt = TRUST_THRESHOLDS.find((threshold) => threshold > state.totalPaperclips) ?? null;
  const operationCapacity = state.memory * 1_000;
  const operationsPerSecond = state.processors * 9 * processorBoost;
  const creativityPerSecond =
    state.operations >= operationCapacity && operationCapacity > 0 ? state.processors * 0.12 : 0;

  return {
    clipsPerSecond,
    clipsSoldPerSecond,
    demand,
    trust,
    nextTrustAt,
    availableTrust: Math.max(0, trust - state.processors - state.memory),
    operationCapacity,
    operationsPerSecond,
    creativityPerSecond,
    wirePerClip,
    autoClipperCost: roundMoney(5 * Math.pow(1.15, state.autoClippers)),
    megaClipperCost: roundMoney(500 * Math.pow(1.18, state.megaClippers)),
    marketingCost: roundMoney(100 * Math.pow(2, state.marketingLevel - 1)),
    wireCost: state.wirePrice,
    valuation: roundMoney(state.funds + state.paperclips * state.price)
  };
}

export function advanceGame(input: GameState, now = Date.now()): GameState {
  const elapsedSeconds = clamp((now - input.lastTickAt) / 1000, 0, 60);
  if (elapsedSeconds <= 0) {
    return input;
  }

  const state = cloneGame(input);
  state.lastTickAt = now;
  state.updatedAt = now;

  buyWireIfHelpful(state);

  const beforeProduction = deriveGame(state);
  const automaticClips = beforeProduction.clipsPerSecond * elapsedSeconds;
  produceClips(state, automaticClips, beforeProduction.wirePerClip);

  buyWireIfHelpful(state);

  const afterProduction = deriveGame(state);
  const sold = Math.min(state.paperclips, afterProduction.clipsSoldPerSecond * elapsedSeconds);
  if (sold > 0) {
    state.paperclips -= sold;
    state.funds += sold * state.price;
  }

  state.operations = Math.min(
    afterProduction.operationCapacity,
    state.operations + afterProduction.operationsPerSecond * elapsedSeconds
  );

  if (state.operations >= afterProduction.operationCapacity && afterProduction.operationCapacity > 0) {
    state.creativity += afterProduction.creativityPerSecond * elapsedSeconds;
  }

  return cleanGame(state);
}

export function applyAction(
  input: GameState,
  action: GameAction,
  now = Date.now()
): { state: GameState; ok: boolean; message: string } {
  const state = cloneGame(advanceGame(input, now));
  const derived = deriveGame(state);

  switch (action) {
    case "make_paperclip": {
      const made = produceClips(state, 1, derived.wirePerClip);
      if (made <= 0) {
        return result(state, false, "Not enough wire.");
      }
      pushLog(state, "Made a paperclip by hand.");
      return result(state, true, "Made one paperclip.");
    }
    case "lower_price":
      state.price = roundMoney(Math.max(0.01, state.price - 0.01));
      return result(state, true, `Price lowered to $${state.price.toFixed(2)}.`);
    case "raise_price":
      state.price = roundMoney(state.price + 0.01);
      return result(state, true, `Price raised to $${state.price.toFixed(2)}.`);
    case "buy_wire":
      if (!canAfford(state, { funds: derived.wireCost })) {
        return result(state, false, "Not enough funds for wire.");
      }
      buyWireBundle(state);
      return result(state, true, "Bought 1,000 inches of wire.");
    case "toggle_wire_buyer":
      state.autoWireBuyer = !state.autoWireBuyer;
      return result(state, true, `Wire buyer ${state.autoWireBuyer ? "enabled" : "disabled"}.`);
    case "buy_auto_clipper":
      if (!canAfford(state, { funds: derived.autoClipperCost })) {
        return result(state, false, "Not enough funds for an AutoClipper.");
      }
      spend(state, { funds: derived.autoClipperCost });
      state.autoClippers += 1;
      pushLog(state, "Added one AutoClipper.");
      return result(state, true, "Bought an AutoClipper.");
    case "buy_mega_clipper":
      if (!canAfford(state, { funds: derived.megaClipperCost })) {
        return result(state, false, "Not enough funds for a MegaClipper.");
      }
      spend(state, { funds: derived.megaClipperCost });
      state.megaClippers += 1;
      pushLog(state, "Added one MegaClipper.");
      return result(state, true, "Bought a MegaClipper.");
    case "buy_marketing":
      if (!canAfford(state, { funds: derived.marketingCost })) {
        return result(state, false, "Not enough funds for marketing.");
      }
      spend(state, { funds: derived.marketingCost });
      state.marketingLevel += 1;
      pushLog(state, `Marketing increased to level ${state.marketingLevel}.`);
      return result(state, true, "Bought marketing.");
    case "add_processor":
      if (derived.availableTrust <= 0) {
        return result(state, false, "No available trust.");
      }
      state.processors += 1;
      pushLog(state, "Allocated trust to processors.");
      return result(state, true, "Added a processor.");
    case "add_memory":
      if (derived.availableTrust <= 0) {
        return result(state, false, "No available trust.");
      }
      state.memory += 1;
      pushLog(state, "Allocated trust to memory.");
      return result(state, true, "Added memory.");
    case "run_tournament":
      if (!canAfford(state, { operations: 1_000 })) {
        return result(state, false, "Not enough operations for a tournament.");
      }
      spend(state, { operations: 1_000 });
      state.yomi += hasUpgrade(state, "tournament_engine") ? 60 : 40;
      state.creativity += 4;
      pushLog(state, "Ran a strategy tournament.");
      return result(state, true, "Tournament complete.");
    case "buy_upgrade_efficient_clippers":
    case "buy_upgrade_wire_saver":
    case "buy_upgrade_market_forecaster":
    case "buy_upgrade_parallel_processors":
    case "buy_upgrade_tournament_engine":
      return buyUpgrade(state, action);
    case "wait":
      return result(state, true, "Advanced the game clock.");
    default:
      return result(state, false, "Unknown action.");
  }
}

export function listAvailableActions(state: GameState): ActionAvailability[] {
  const derived = deriveGame(state);
  const base: ActionAvailability[] = [
    availability("make_paperclip", state.wire >= derived.wirePerClip, "Need wire."),
    availability("lower_price", state.price > 0.01, "Already at minimum price."),
    availability("raise_price", true),
    availability("buy_wire", canAfford(state, { funds: derived.wireCost }), "Need more funds."),
    availability("toggle_wire_buyer", true),
    availability(
      "buy_auto_clipper",
      canAfford(state, { funds: derived.autoClipperCost }),
      "Need more funds."
    ),
    availability(
      "buy_mega_clipper",
      canAfford(state, { funds: derived.megaClipperCost }),
      "Need more funds."
    ),
    availability("buy_marketing", canAfford(state, { funds: derived.marketingCost }), "Need more funds."),
    availability("add_processor", derived.availableTrust > 0, "Need trust."),
    availability("add_memory", derived.availableTrust > 0, "Need trust."),
    availability("run_tournament", canAfford(state, { operations: 1_000 }), "Need 1,000 ops."),
    availability("wait", true)
  ];

  const upgradeActions = UPGRADES.map((upgrade) =>
    availability(
      upgrade.action,
      !hasUpgrade(state, upgrade.id) && canAfford(state, upgrade.cost),
      hasUpgrade(state, upgrade.id) ? "Already installed." : `Needs ${formatCost(upgrade.cost)}.`
    )
  );

  return [...base, ...upgradeActions];
}

export function chooseDemoAgentAction(state: GameState): GameAction {
  const derived = deriveGame(state);
  const affordableUpgrade = UPGRADES.find(
    (upgrade) => !hasUpgrade(state, upgrade.id) && canAfford(state, upgrade.cost)
  );

  if (affordableUpgrade) return affordableUpgrade.action;
  if (state.wire < 80 && canAfford(state, { funds: derived.wireCost })) return "buy_wire";
  if (!state.autoWireBuyer && state.funds > 75) return "toggle_wire_buyer";
  if (derived.availableTrust > 0 && state.operations > derived.operationCapacity * 0.7) return "add_memory";
  if (derived.availableTrust > 0) return "add_processor";
  if (state.operations >= 1_000) return "run_tournament";
  if (canAfford(state, { funds: derived.autoClipperCost }) && state.autoClippers < 25) {
    return "buy_auto_clipper";
  }
  if (canAfford(state, { funds: derived.megaClipperCost }) && state.autoClippers >= 12) {
    return "buy_mega_clipper";
  }
  if (derived.demand < 0.18 && state.price > 0.08) return "lower_price";
  if (derived.demand > 0.85 && state.paperclips < derived.clipsSoldPerSecond * 4) return "raise_price";
  if (canAfford(state, { funds: derived.marketingCost }) && derived.demand < 0.75) return "buy_marketing";
  if (state.wire >= derived.wirePerClip) return "make_paperclip";
  return "wait";
}

export function formatCost(cost: ResourceCost): string {
  const parts: string[] = [];
  if (cost.funds) parts.push(`$${formatNumber(cost.funds)}`);
  if (cost.operations) parts.push(`${formatNumber(cost.operations)} ops`);
  if (cost.creativity) parts.push(`${formatNumber(cost.creativity)} creativity`);
  if (cost.yomi) parts.push(`${formatNumber(cost.yomi)} yomi`);
  return parts.join(", ");
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}b`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (absolute >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (absolute >= 1_000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (absolute >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (absolute >= 10) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function buyUpgrade(state: GameState, action: GameAction) {
  const upgrade = UPGRADES.find((candidate) => candidate.action === action);
  if (!upgrade) return result(state, false, "Unknown upgrade.");
  if (hasUpgrade(state, upgrade.id)) return result(state, false, "Upgrade already installed.");
  if (!canAfford(state, upgrade.cost)) return result(state, false, `Needs ${formatCost(upgrade.cost)}.`);
  spend(state, upgrade.cost);
  state.upgrades.push(upgrade.id);
  pushLog(state, `${upgrade.name} installed.`);
  return result(state, true, `${upgrade.name} installed.`);
}

function availability(action: GameAction, available: boolean, reason?: string): ActionAvailability {
  return {
    action,
    label: ACTION_LABELS[action],
    available,
    reason: available ? undefined : reason
  };
}

function calculateTrust(totalPaperclips: number): number {
  return 2 + TRUST_THRESHOLDS.filter((threshold) => totalPaperclips >= threshold).length;
}

function produceClips(state: GameState, requestedClips: number, wirePerClip: number): number {
  const clips = Math.max(0, Math.min(requestedClips, state.wire / wirePerClip));
  if (clips <= 0) return 0;
  state.paperclips += clips;
  state.totalPaperclips += clips;
  state.wire -= clips * wirePerClip;
  return clips;
}

function buyWireIfHelpful(state: GameState) {
  if (!state.autoWireBuyer) return;
  while (state.wire < 250 && state.funds >= state.wirePrice) {
    buyWireBundle(state);
  }
}

function buyWireBundle(state: GameState) {
  spend(state, { funds: state.wirePrice });
  state.wire += 1_000;
  state.marketSeed = nextSeed(state.marketSeed);
  state.wirePrice = roundMoney(14 + (state.marketSeed % 1_900) / 100);
  pushLog(state, `Bought wire at $${state.wirePrice.toFixed(2)} market quote.`);
}

function spend(state: GameState, cost: ResourceCost) {
  state.funds -= cost.funds ?? 0;
  state.operations -= cost.operations ?? 0;
  state.creativity -= cost.creativity ?? 0;
  state.yomi -= cost.yomi ?? 0;
}

function canAfford(state: GameState, cost: ResourceCost): boolean {
  return (
    state.funds >= (cost.funds ?? 0) &&
    state.operations >= (cost.operations ?? 0) &&
    state.creativity >= (cost.creativity ?? 0) &&
    state.yomi >= (cost.yomi ?? 0)
  );
}

function hasUpgrade(state: GameState, upgrade: UpgradeId): boolean {
  return state.upgrades.includes(upgrade);
}

function pushLog(state: GameState, text: string) {
  state.log = [{ at: Date.now(), text }, ...state.log].slice(0, 8);
}

function result(state: GameState, ok: boolean, message: string) {
  state.updatedAt = Date.now();
  return { state: cleanGame(state), ok, message };
}

function cloneGame(state: GameState): GameState {
  return {
    ...state,
    upgrades: [...state.upgrades],
    log: [...state.log]
  };
}

function cleanGame(state: GameState): GameState {
  return {
    ...state,
    paperclips: roundSoft(state.paperclips),
    totalPaperclips: roundSoft(state.totalPaperclips),
    wire: roundSoft(Math.max(0, state.wire)),
    wirePrice: roundMoney(state.wirePrice),
    funds: roundMoney(Math.max(0, state.funds)),
    price: roundMoney(Math.max(0.01, state.price)),
    operations: roundSoft(Math.max(0, state.operations)),
    creativity: roundSoft(Math.max(0, state.creativity)),
    yomi: roundSoft(Math.max(0, state.yomi))
  };
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundSoft(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000) / 1_000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function nextSeed(seed: number): number {
  return (seed * 1_664_525 + 1_013_904_223) >>> 0;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
