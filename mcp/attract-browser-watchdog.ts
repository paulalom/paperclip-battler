import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

type WatchdogConfig = {
  parentPid: number;
  command: string;
  args: string[];
  profileDir: string;
  label: string;
  parentPollMs?: number;
  shutdownGraceMs?: number;
};

const config = parseConfig(process.argv[2]);
const parentPollMs = Math.max(250, config.parentPollMs ?? 1_000);
const shutdownGraceMs = Math.max(500, config.shutdownGraceMs ?? 5_000);

process.title = sanitizeProcessLabel(`${config.label}-watchdog`);

const browser = spawn(config.command, config.args, {
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true
});

let shuttingDown = false;
let exited = false;

browser.stderr?.on("data", (chunk) => {
  process.stderr.write(chunk);
});

browser.once("exit", (code, signal) => {
  void finish(typeof code === "number" ? code : signal ? 1 : 0);
});

browser.once("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Attract browser failed to start."}\n`);
  void finish(1);
});

const parentTimer = setInterval(() => {
  if (!isProcessAlive(config.parentPid)) {
    void shutdown("parent-exit");
  }
}, parentPollMs);
parentTimer.unref();

process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.includes("shutdown")) void shutdown("shutdown-request");
});
process.stdin.once("end", () => void shutdown("stdin-closed"));
process.stdin.once("close", () => void shutdown("stdin-closed"));

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => void shutdown(signal));
}

async function shutdown(_reason: string) {
  if (shuttingDown || exited) return;
  shuttingDown = true;
  clearInterval(parentTimer);

  await terminateProcessTree(browser.pid);

  const forceExit = setTimeout(() => {
    void finish(0);
  }, shutdownGraceMs);
  forceExit.unref();
}

async function finish(exitCode: number) {
  if (exited) return;
  exited = true;
  clearInterval(parentTimer);
  await cleanupProfile(config.profileDir);
  process.exit(exitCode);
}

async function terminateProcessTree(pid: number | undefined) {
  if (!pid || !isProcessAlive(pid)) return;

  if (process.platform === "win32") {
    await waitForProcess(
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      })
    );
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 1_000));
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process already exited.
    }
  }
}

async function cleanupProfile(profileDir: string) {
  try {
    await rm(profileDir, { recursive: true, force: true });
  } catch {
    // Temporary browser profiles are best-effort cleanup.
  }
}

function waitForProcess(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseConfig(value: string | undefined): WatchdogConfig {
  if (!value) fail("Missing attract browser watchdog config.");
  try {
    const parsed = JSON.parse(value) as WatchdogConfig;
    if (
      !Number.isInteger(parsed.parentPid) ||
      parsed.parentPid <= 0 ||
      typeof parsed.command !== "string" ||
      !parsed.command ||
      !Array.isArray(parsed.args) ||
      typeof parsed.profileDir !== "string" ||
      !parsed.profileDir ||
      typeof parsed.label !== "string" ||
      !parsed.label
    ) {
      fail("Invalid attract browser watchdog config.");
    }
    return parsed;
  } catch {
    fail("Invalid attract browser watchdog config.");
  }
}

function sanitizeProcessLabel(value: unknown) {
  const label = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return label || "paperclip-battler-attract-watchdog";
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
