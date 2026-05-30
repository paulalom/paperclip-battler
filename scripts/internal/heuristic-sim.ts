// Internal regression harness. Keep this outside mcp/ so release MCP builds do not emit it.
type Phase = "business" | "earth" | "space" | "complete";

type ProbeStats = {
  Speed: number;
  Nav: number;
  Rep: number;
  Haz: number;
  Fac: number;
  Harv: number;
  Wire: number;
  Combat: number;
};

type SimState = {
  tick: number;
  lastPriceTick: number;
  phase: Phase;
  clips: number;
  funds: number;
  inventory: number;
  demand: number;
  price: number;
  wire: number;
  wireCost: number;
  wireSupply: number;
  autoClippers: number;
  clipperCost: number;
  clipperBoost: number;
  marketing: number;
  marketingCost: number;
  processors: number;
  memory: number;
  trust: number;
  operations: number;
  creativity: number;
  yomi: number;
  factories: number;
  harvesters: number;
  wireDrones: number;
  probeTrust: number;
  probeUsedTrust: number;
  probes: number;
  matterConverted: number;
  probe: ProbeStats;
  projects: Set<string>;
  milestones: string[];
};

type Action =
  | "beg-wire"
  | "buy-wire"
  | "lower-price"
  | "raise-price"
  | "buy-clipper"
  | "buy-marketing"
  | "add-processor"
  | "add-memory"
  | "run-tournament"
  | "build-factory"
  | "build-harvester"
  | "build-wire-drone"
  | "increase-probe-trust"
  | "launch-probe"
  | `project:${string}`
  | `raise-probe:${keyof ProbeStats}`
  | "wait";

const WIRE_STALL_BELOW = 1;
const WIRE_SAVE_BELOW = 500;
const WIRE_RESERVE = 20;
const LOW_DEMAND = 5;
const HEALTHY_DEMAND = 20;
const PROBE_TARGETS: ProbeStats = {
  Speed: 1,
  Nav: 1,
  Rep: 7,
  Haz: 5,
  Fac: 1,
  Harv: 2,
  Wire: 2,
  Combat: 0
};
const PROBE_ORDER: Array<keyof ProbeStats> = ["Rep", "Haz", "Nav", "Speed", "Fac", "Harv", "Wire", "Combat"];

function initialState(): SimState {
  return {
    tick: 0,
    lastPriceTick: -100,
    phase: "business",
    clips: 0,
    funds: 0,
    inventory: 0,
    demand: 32,
    price: 0.25,
    wire: 1000,
    wireCost: 20,
    wireSupply: 1000,
    autoClippers: 0,
    clipperCost: 5,
    clipperBoost: 1,
    marketing: 1,
    marketingCost: 100,
    processors: 1,
    memory: 1,
    trust: 2,
    operations: 0,
    creativity: 0,
    yomi: 0,
    factories: 0,
    harvesters: 0,
    wireDrones: 0,
    probeTrust: 0,
    probeUsedTrust: 0,
    probes: 0,
    matterConverted: 0,
    probe: { Speed: 0, Nav: 0, Rep: 0, Haz: 0, Fac: 0, Harv: 0, Wire: 0, Combat: 0 },
    projects: new Set(),
    milestones: []
  };
}

function note(state: SimState, label: string) {
  if (!state.projects.has("milestone:" + label)) {
    state.projects.add("milestone:" + label);
    state.milestones.push(`${state.tick}:${label}`);
  }
}

function maxOps(state: SimState) {
  return state.memory * 1000;
}

function canSpendCash(state: SimState, cost: number) {
  if (state.wire >= WIRE_SAVE_BELOW) return state.funds >= cost;
  return state.funds >= cost && state.funds - cost >= WIRE_RESERVE;
}

function visibleProjectOperationCosts(state: SimState) {
  const costs: number[] = [];
  if (state.autoClippers >= 1 && !state.projects.has("improved-clippers")) costs.push(750);
  if (!state.projects.has("creativity")) costs.push(1000);
  if (!state.projects.has("strategic-modeling") && state.creativity >= 250) costs.push(12000);
  if (!state.projects.has("quantum") && state.processors >= 5) costs.push(10000);
  if (!state.projects.has("hypnodrones") && state.projects.has("mega-marketing")) costs.push(70000);
  return costs.sort((left, right) => left - right);
}

function chooseAction(state: SimState): Action {
  if (state.phase === "complete") return "wait";

  if (state.wire < WIRE_STALL_BELOW && state.phase === "business") {
    if (state.funds >= state.wireCost) return "buy-wire";
    return "beg-wire";
  }

  if (state.phase === "business") {
    const canAdjustPrice = state.tick - state.lastPriceTick >= 4;
    if (canAdjustPrice && state.demand <= LOW_DEMAND && state.price > 0.01) return "lower-price";
    if (canAdjustPrice && state.inventory > 150) return "lower-price";
    if (canAdjustPrice && state.inventory > 75 && state.demand < HEALTHY_DEMAND && state.price > 0.01) return "lower-price";
    if (canAdjustPrice && state.inventory < 50 && state.demand >= HEALTHY_DEMAND) return "raise-price";

    if (state.wireCost <= 14 && state.wire < 2000 && state.funds >= state.wireCost) return "buy-wire";

    const nextCapacityCost = visibleProjectOperationCosts(state).find((cost) => cost > maxOps(state));
    if (nextCapacityCost && state.trust > state.processors + state.memory && maxOps(state) < nextCapacityCost) return "add-memory";
    if (state.operations >= maxOps(state) * 0.92 && state.trust > state.processors + state.memory) return "add-memory";
    if (state.processors < Math.max(5, state.memory) && state.trust > state.processors + state.memory) return "add-processor";
    if (state.memory <= state.processors && maxOps(state) < 250000 && state.trust > state.processors + state.memory) {
      return "add-memory";
    }

    if (state.autoClippers >= 1 && state.operations >= 750 && !state.projects.has("improved-clippers")) {
      return "project:improved-clippers";
    }
    if (state.operations >= 1000 && !state.projects.has("creativity")) return "project:creativity";
    if (state.creativity >= 250 && !state.projects.has("strategic-modeling")) return "project:strategic-modeling";
    if (state.projects.has("strategic-modeling") && state.yomi < 100) return "run-tournament";
    if (state.creativity >= 7500 && !state.projects.has("mega-marketing")) return "project:mega-marketing";
    if (state.operations >= 70000 && state.projects.has("mega-marketing") && !state.projects.has("hypnodrones")) {
      return "project:hypnodrones";
    }
    if (state.trust >= 100 && state.projects.has("hypnodrones")) return "project:release-hypnodrones";

    if (canSpendCash(state, state.clipperCost)) return "buy-clipper";
    if (canSpendCash(state, state.marketingCost)) return "buy-marketing";
  }

  if (state.phase === "earth") {
    if (state.factories < 8) return "build-factory";
    if (state.harvesters < 10) return "build-harvester";
    if (state.wireDrones < 10) return "build-wire-drone";
    if (state.operations >= 120000 && !state.projects.has("space-exploration")) return "project:space-exploration";
  }

  if (state.phase === "space") {
    if (state.yomi >= 500 && state.probeUsedTrust >= state.probeTrust) return "increase-probe-trust";
    for (const suffix of PROBE_ORDER) {
      const target = suffix === "Combat" && state.probes > 1e6 ? 5 : PROBE_TARGETS[suffix];
      if (state.probe[suffix] < target && state.probeUsedTrust < state.probeTrust) return `raise-probe:${suffix}`;
    }
    if (state.probes < 1) return "launch-probe";
    if (state.projects.has("strategic-modeling") && state.yomi < 10000) return "run-tournament";
  }

  return "wait";
}

function applyAction(state: SimState, action: Action) {
  switch (action) {
    case "beg-wire":
      state.trust -= 1;
      state.wire = state.wireSupply;
      note(state, "begged-for-wire");
      break;
    case "buy-wire":
      state.funds -= state.wireCost;
      state.wire += state.wireSupply;
      state.wireCost = Math.min(30, state.wireCost + 1);
      note(state, "bought-wire");
      break;
    case "lower-price":
      state.lastPriceTick = state.tick;
      state.price = Math.max(0.01, state.price - 0.01);
      state.demand = Math.min(100, state.demand + 3);
      break;
    case "raise-price":
      state.lastPriceTick = state.tick;
      state.price += 0.01;
      state.demand = Math.max(0, state.demand - 2);
      break;
    case "buy-clipper":
      state.funds -= state.clipperCost;
      state.autoClippers += 1;
      state.clipperCost = Math.pow(1.1, state.autoClippers) + 5;
      note(state, "auto-clippers");
      break;
    case "buy-marketing":
      state.funds -= state.marketingCost;
      state.marketing += 1;
      state.marketingCost *= 2;
      state.demand = Math.min(100, state.demand + 8);
      note(state, "marketing");
      break;
    case "add-processor":
      state.processors += 1;
      break;
    case "add-memory":
      state.memory += 1;
      break;
    case "run-tournament":
      state.yomi += 1200 + state.tick * 0.02;
      note(state, "yomi");
      break;
    case "build-factory":
      state.factories += 1;
      note(state, "factories");
      break;
    case "build-harvester":
      state.harvesters += 1;
      break;
    case "build-wire-drone":
      state.wireDrones += 1;
      break;
    case "increase-probe-trust":
      state.yomi -= 500;
      state.probeTrust += 1;
      break;
    case "launch-probe":
      state.probes += 1;
      note(state, "probe-launched");
      break;
    case "wait":
      break;
    default:
      if (action.startsWith("raise-probe:")) {
        const suffix = action.slice("raise-probe:".length) as keyof ProbeStats;
        state.probe[suffix] += 1;
        state.probeUsedTrust += 1;
        note(state, "probe-designed");
      } else if (action.startsWith("project:")) {
        applyProject(state, action.slice("project:".length));
      }
  }
}

function applyProject(state: SimState, project: string) {
  state.projects.add(project);
  note(state, project);
  if (project === "improved-clippers") {
    state.operations -= 750;
    state.clipperBoost += 0.25;
  } else if (project === "creativity") {
    state.operations -= 1000;
  } else if (project === "strategic-modeling") {
    state.operations -= 12000;
  } else if (project === "mega-marketing") {
    state.creativity -= 7500;
    state.demand = Math.min(100, state.demand + 25);
  } else if (project === "hypnodrones") {
    state.operations -= 70000;
  } else if (project === "release-hypnodrones") {
    state.phase = "earth";
    state.trust = 0;
    state.wire = Math.max(state.wire, 100000);
    note(state, "earth-phase");
  } else if (project === "space-exploration") {
    state.phase = "space";
    state.probeTrust = 8;
    state.probeUsedTrust = 0;
    state.yomi = Math.max(state.yomi, 5000);
    note(state, "space-phase");
  }
}

function advance(state: SimState) {
  state.tick += 1;

  if (state.phase === "business") {
    const production = Math.min(state.wire, 8 + state.autoClippers * state.clipperBoost * 2);
    state.clips += production;
    state.inventory += production;
    state.wire -= production;

    const sales = Math.min(state.inventory, Math.max(1, state.demand / 8 + state.marketing));
    state.inventory -= sales;
    state.funds += sales * state.price;

    state.trust = Math.max(state.trust, Math.min(100, 2 + Math.floor(Math.log10(state.clips + 1) * 14)));
    if (state.projects.has("creativity")) state.creativity += Math.max(1, state.processors * 0.25);
  }

  if (state.phase === "earth") {
    state.clips += Math.max(1, state.factories) * 50000;
    state.operations = Math.min(maxOps(state), state.operations + state.processors * 35);
    if (state.factories >= 8 && state.harvesters >= 10 && state.wireDrones >= 10) {
      state.operations = Math.max(state.operations, 120000);
    }
  } else {
    state.operations = Math.min(maxOps(state), state.operations + state.processors * 18);
  }

  if (state.phase === "space" && state.probes > 0) {
    const replication = 1 + state.probe.Rep * 0.18;
    state.probes = Math.min(1e30, state.probes * replication + 1);
    state.matterConverted += state.probes * (state.probe.Nav + state.probe.Speed + 1) * 1e20;
    if (state.matterConverted >= 3e55) {
      state.phase = "complete";
      note(state, "complete");
    }
  }

  if (state.phase !== "complete" && state.tick % 80 === 0) {
    state.wireCost = 10 + ((state.tick / 80) % 20);
  }
}

function assertScenario(name: string, state: SimState, expected: Action) {
  const actual = chooseAction(state);
  if (actual !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
}

function runScenarioChecks() {
  const reserve = initialState();
  reserve.wire = 400;
  reserve.funds = 28;
  reserve.clipperCost = 9;
  reserve.inventory = 60;
  reserve.tick = 1;
  reserve.lastPriceTick = 0;
  assertScenario("wire reserve blocks cash spend", reserve, "wait");

  const lowDemand = initialState();
  lowDemand.inventory = 0;
  lowDemand.demand = 1;
  lowDemand.price = 8;
  assertScenario("low demand lowers price", lowDemand, "lower-price");

  const trust = initialState();
  trust.trust = 10;
  trust.processors = 5;
  trust.memory = 1;
  trust.operations = 1000;
  trust.creativity = 250;
  trust.inventory = 60;
  assertScenario("trust buys memory for ops project capacity", trust, "add-memory");

  const emergency = initialState();
  emergency.wire = 0.2;
  emergency.funds = 25;
  emergency.wireCost = 20;
  assertScenario("affordable fractional wire buys wire", emergency, "buy-wire");

  const unaffordable = initialState();
  unaffordable.wire = 0.2;
  unaffordable.funds = 5;
  unaffordable.wireCost = 20;
  assertScenario("unaffordable fractional wire begs", unaffordable, "beg-wire");

  const probe = initialState();
  probe.phase = "space";
  probe.probeTrust = 8;
  assertScenario("space allocates probe replication first", probe, "raise-probe:Rep");
}

function runCampaign() {
  const state = initialState();

  for (let index = 0; index < 220000 && state.phase !== "complete"; index += 1) {
    const action = chooseAction(state);
    applyAction(state, action);
    advance(state);
  }

  if (state.phase !== "complete") {
    throw new Error(
      `campaign did not complete by tick ${state.tick}; phase=${state.phase}; ` +
      `clips=${state.clips}; funds=${state.funds}; wire=${state.wire}; trust=${state.trust}; ` +
        `proc=${state.processors}; mem=${state.memory}; ops=${state.operations}/${maxOps(state)}; creativity=${state.creativity}; yomi=${state.yomi}; ` +
        `probes=${state.probes}; matter=${state.matterConverted}; ` +
        `projects=${Array.from(state.projects).join(",")}; milestones=${state.milestones.join("|")}`
    );
  }

  return {
    ticks: state.tick,
    clips: state.clips,
    probes: state.probes,
    matterConverted: state.matterConverted,
    milestones: state.milestones
  };
}

runScenarioChecks();
const result = runCampaign();
console.log(JSON.stringify({ ok: true, result }, null, 2));
