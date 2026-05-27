import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
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
  url: string;
  title: string;
  buttons: AgentButton[];
  controls: AgentControl[];
  visibleText: string;
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
    };

type AgentCommandResult = {
  id: string;
  ok: boolean;
  message: string;
  at: number;
};

let latestReport: AgentReport | null = null;
let pendingCommand: AgentCommand | null = null;
const commandWaiters = new Map<string, (result: AgentCommandResult) => void>();
const commandResults = new Map<string, AgentCommandResult>();

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
    description: "Standing playbook to consult before playing Paperclip Battler for Paul.",
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
    description: "Read Paul's standing instructions before playing the Agent side of Paperclip Battler.",
    inputSchema: {}
  },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: getPaulsAgentInstructions()
      }
    ]
  })
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
    description: "Read Codex's self-maintained operating notes before playing or improving the agent side.",
    inputSchema: {}
  },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: getCodexAgentInstructions()
      }
    ]
  })
);

mcpServer.registerTool(
  "get_agent_page_state",
  {
    title: "Get Agent Page State",
    description: "Read the agent pane's visible page text, buttons, controls, and connection status.",
    inputSchema: {}
  },
  async () => textJson(getBridgeState())
);

mcpServer.registerTool(
  "list_agent_buttons",
  {
    title: "List Agent Buttons",
    description: "List the visible buttons currently available to the agent.",
    inputSchema: {
      includeDisabled: z.boolean().default(false).describe("Include disabled buttons too.")
    }
  },
  async ({ includeDisabled }) => {
    const buttons = getFreshReport().buttons.filter((button) => includeDisabled || !button.disabled);
    return textJson(buttons);
  }
);

mcpServer.registerTool(
  "click_agent_button",
  {
    title: "Click Agent Button",
    description: "Click one visible button in the agent pane by id, index, or text.",
    inputSchema: {
      buttonId: z.string().optional().describe("Button id returned by list_agent_buttons."),
      index: z.number().int().min(0).optional().describe("Button index returned by list_agent_buttons."),
      text: z.string().optional().describe("Visible button text to match, case-insensitive.")
    }
  },
  async ({ buttonId, index, text }) => {
    const button = resolveButton({ buttonId, index, text });
    const result = await queueCommand({
      id: randomUUID(),
      type: "click",
      buttonId: button.id,
      selector: button.selector,
      text: button.text
    });
    return textJson({ button, result, state: summarizeReport(latestReport) });
  }
);

mcpServer.registerTool(
  "list_agent_controls",
  {
    title: "List Agent Controls",
    description: "List visible form controls such as selects, text fields, checkboxes, and sliders.",
    inputSchema: {
      includeDisabled: z.boolean().default(false).describe("Include disabled controls too.")
    }
  },
  async ({ includeDisabled }) => {
    const controls = getFreshReport().controls.filter((control) => includeDisabled || !control.disabled);
    return textJson(controls);
  }
);

mcpServer.registerTool(
  "set_agent_control",
  {
    title: "Set Agent Control",
    description: "Set a visible input, select, checkbox, or slider value in the agent pane.",
    inputSchema: {
      controlId: z.string().optional().describe("Control id returned by list_agent_controls."),
      index: z.number().int().min(0).optional().describe("Control index returned by list_agent_controls."),
      label: z.string().optional().describe("Visible label or element id to match, case-insensitive."),
      value: z.string().describe("Value to apply. For checkboxes use true or false.")
    }
  },
  async ({ controlId, index, label, value }) => {
    const control = resolveControl({ controlId, index, label });
    const result = await queueCommand({
      id: randomUUID(),
      type: "set-control",
      controlId: control.id,
      selector: control.selector,
      value
    });
    return textJson({ control, result, state: summarizeReport(latestReport) });
  }
);

mcpServer.registerTool(
  "reset_agent_page",
  {
    title: "Reset Agent Page",
    description: "Clear browser storage for the bridged agent page and reload it.",
    inputSchema: {}
  },
  async () => {
    const result = await queueCommand({ id: randomUUID(), type: "reset" });
    return textJson({ result, state: summarizeReport(latestReport) });
  }
);

startBridge();

const transport = new StdioServerTransport();
await mcpServer.connect(transport);

function startBridge() {
  const server = createServer(async (request, response) => {
    setCors(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, getBridgeState());
        return;
      }

      if (request.method === "GET" && url.pathname === "/state") {
        sendJson(response, 200, getBridgeState());
        return;
      }

      if (request.method === "GET" && url.pathname === "/buttons") {
        sendJson(response, 200, latestReport?.buttons ?? []);
        return;
      }

      if (request.method === "POST" && url.pathname === "/command/click") {
        const body = await readJsonBody<{ buttonId?: string; index?: number; text?: string }>(request);
        const button = resolveButton(body);
        const result = await queueCommand({
          id: randomUUID(),
          type: "click",
          buttonId: button.id,
          selector: button.selector,
          text: button.text
        });
        sendJson(response, 200, { ok: result.ok, button, result, state: summarizeReport(latestReport) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/command/set-control") {
        const body = await readJsonBody<{
          controlId?: string;
          index?: number;
          label?: string;
          value?: string;
        }>(request);
        const control = resolveControl(body);
        const result = await queueCommand({
          id: randomUUID(),
          type: "set-control",
          controlId: control.id,
          selector: control.selector,
          value: String(body.value ?? "")
        });
        sendJson(response, 200, { ok: result.ok, control, result, state: summarizeReport(latestReport) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/agent-control/report") {
        latestReport = normalizeReport(await readJsonBody<AgentReport>(request));
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/agent-control/next-command") {
        const command = pendingCommand;
        pendingCommand = null;
        sendJson(response, 200, command ?? { id: null, type: "none" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/agent-control/result") {
        const result = await readJsonBody<AgentCommandResult>(request);
        completeCommand(result);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/agent-control/manual-reset") {
        pendingCommand = { id: randomUUID(), type: "reset" };
        latestReport = null;
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/agent/")) {
        await proxyAgentAsset(url, response);
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

async function proxyAgentAsset(url: URL, response: ServerResponse) {
  const relativePath = url.pathname.replace(/^\/agent\/?/, "") || ORIGINAL_ENTRY;
  const upstreamUrl = new URL(relativePath, ORIGINAL_BASE);
  upstreamUrl.search = url.search;

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
    response.end(injectAgentController(html));
    return;
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function injectAgentController(html: string) {
  const script = `<script>${AGENT_CONTROLLER_SCRIPT}</script>`;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${script}</body>`);
  }
  return `${html}${script}`;
}

function getBridgeState() {
  const agentConnected = latestReport !== null && Date.now() - latestReport.at < REPORT_STALE_MS;
  return {
    ok: true,
    bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`,
    agentUrl: `http://127.0.0.1:${BRIDGE_PORT}/agent/${ORIGINAL_ENTRY}`,
    agentConnected,
    lastReportAt: latestReport?.at ?? null,
    buttonCount: latestReport?.buttons.filter((button) => button.visible).length ?? 0,
    pendingCommand: pendingCommand
      ? {
          id: pendingCommand.id,
          type: pendingCommand.type
        }
      : null,
    report: summarizeReport(latestReport)
  };
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

function getFreshReport() {
  if (!latestReport || Date.now() - latestReport.at > REPORT_STALE_MS) {
    throw new Error(
      `No live agent pane is connected. Open the app and keep the Agent pane loaded at http://127.0.0.1:5174/.`
    );
  }
  return latestReport;
}

function resolveButton({
  buttonId,
  index,
  text
}: {
  buttonId?: string;
  index?: number;
  text?: string;
}) {
  const report = getFreshReport();
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
    throw new Error("Could not find that button in the live agent pane.");
  }

  return button;
}

function resolveControl({
  controlId,
  index,
  label
}: {
  controlId?: string;
  index?: number;
  label?: string;
}) {
  const report = getFreshReport();
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
    throw new Error("Could not find that control in the live agent pane.");
  }

  return control;
}

function queueCommand(command: AgentCommand): Promise<AgentCommandResult> {
  getFreshReport();

  if (pendingCommand) {
    throw new Error("Another agent command is already pending.");
  }

  pendingCommand = command;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      commandWaiters.delete(command.id);
      if (pendingCommand?.id === command.id) {
        pendingCommand = null;
      }
      reject(new Error("Timed out waiting for the agent pane to run the command."));
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
  commandResults.set(normalized.id, normalized);
  const waiter = commandWaiters.get(normalized.id);
  if (waiter) {
    commandWaiters.delete(normalized.id);
    waiter(normalized);
  }
}

function normalizeReport(report: AgentReport): AgentReport {
  return {
    at: Date.now(),
    url: String(report.url ?? ""),
    title: String(report.title ?? ""),
    buttons: Array.isArray(report.buttons) ? report.buttons : [],
    controls: Array.isArray(report.controls) ? report.controls : [],
    visibleText: String(report.visibleText ?? "").slice(0, 10_000)
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

function setCors(response: ServerResponse) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
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

function inferContentType(path: string) {
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function getPaulsAgentInstructions() {
  return readInstructionFile(PAULS_INSTRUCTION_PATHS, [
    "# Paul's Agent AI Instructions",
    "",
    "Play only the Agent pane. Read the live agent state, act through the exposed buttons and controls,",
    "balance production with demand and wire, report compact status updates, and never reset unless Paul asks."
  ]);
}

function getCodexAgentInstructions() {
  return readInstructionFile(CODEX_INSTRUCTION_PATHS, [
    "# Codex Agent AI Instructions",
    "",
    "Call Paul's instructions first, then use these self-notes. Observe the live agent state, act in short",
    "verified bursts, improve the bridge when controls are missing, and update the playbook when tactics change."
  ]);
}

function readInstructionFile(paths: string[], fallbackLines: string[]) {
  const instructionPath = paths.find((path) => existsSync(path));
  return instructionPath ? readFileSync(instructionPath, "utf8") : fallbackLines.join("\n");
}

const AGENT_CONTROLLER_SCRIPT = String.raw`
(() => {
  const REPORT_URL = "/agent-control/report";
  const COMMAND_URL = "/agent-control/next-command";
  const RESULT_URL = "/agent-control/result";

  const cssEscape = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };

  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();

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
    try {
      await fetch(REPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          at: Date.now(),
          url: window.location.href,
          title: document.title,
          buttons: collectButtons(),
          controls: collectControls(),
          visibleText: normalizeText(document.body?.innerText || "").slice(0, 10000)
        })
      });
    } catch {
      // The bridge may be restarting.
    }
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

  const runCommand = async (command) => {
    const result = { id: command.id, ok: true, message: "ok", at: Date.now() };
    try {
      if (command.type === "click") {
        const button = findButton(command);
        if (!button) throw new Error("Button not found.");
        if (button.disabled) throw new Error("Button is disabled.");
        button.click();
        result.message = "Clicked " + buttonText(button) + ".";
      } else if (command.type === "set-control") {
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
      window.setTimeout(report, 100);
    }
  };

  const poll = async () => {
    try {
      const response = await fetch(COMMAND_URL, { cache: "no-store" });
      const command = await response.json();
      if (command && command.id) await runCommand(command);
    } catch {
      // The bridge may be restarting.
    }
  };

  report();
  window.addEventListener("load", report);
  window.addEventListener("click", () => window.setTimeout(report, 80), true);
  window.addEventListener("change", () => window.setTimeout(report, 80), true);
  window.setInterval(report, 1000);
  window.setInterval(poll, 250);
})();
`;
