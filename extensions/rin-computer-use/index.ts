import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const CONFIG_FILE_NAME = "rin-computer-use.json";

const ComputerUseParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("screenshot"),
    Type.Literal("key"),
    Type.Literal("type"),
    Type.Literal("click"),
    Type.Literal("move"),
  ]),
  text: Type.Optional(Type.String({ description: "Text to type." })),
  key: Type.Optional(Type.String({ description: "Key name for key action." })),
  x: Type.Optional(Type.Number({ description: "Screen x coordinate." })),
  y: Type.Optional(Type.Number({ description: "Screen y coordinate." })),
  button: Type.Optional(Type.Number({ description: "Mouse button number." })),
  path: Type.Optional(
    Type.String({ description: "Output path for screenshot." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Action timeout in milliseconds." }),
  ),
});

type ComputerUseParams = {
  action: "screenshot" | "key" | "type" | "click" | "move";
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  button?: number;
  path?: string;
  timeoutMs?: number;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function screenshotPath(value: unknown) {
  const configured = text(value);
  if (configured) return configured;
  return path.join(os.tmpdir(), `rin-computer-use-${Date.now()}.png`);
}

function parseArgsValue(value: unknown) {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  const raw = text(value);
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readJsonConfig(filePath: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getRinAgentDir() {
  return (
    text(process.env.RIN_DIR) ||
    text(process.env.PI_CODING_AGENT_DIR) ||
    path.join(os.homedir(), ".rin")
  );
}

function readComputerUseConfig() {
  return readJsonConfig(
    path.join(getRinAgentDir(), "extensions", CONFIG_FILE_NAME),
  );
}

async function commandExists(command: string) {
  try {
    if (process.platform === "win32") {
      await execFileAsync("where", [command], { timeout: 2_000 });
    } else {
      await execFileAsync("/usr/bin/env", ["which", command], {
        timeout: 2_000,
      });
    }
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { stdin?: string; timeoutMs?: number } = {},
) {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(
      () => {
        child.kill("SIGTERM");
        reject(new Error("computer_use_timeout"));
      },
      Math.max(1, options.timeoutMs || 30_000),
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code && code !== 0) {
        reject(new Error(stderr.trim() || `computer_use_exit_${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(options.stdin || "");
  });
}

function resolveAdapterConfig(config: Record<string, any>) {
  const adapter = isRecord(config.adapter) ? config.adapter : {};
  return {
    command: text(adapter.command || config.adapterCommand),
    args: parseArgsValue(adapter.args || config.adapterArgs),
  };
}

async function runAdapter(
  config: Record<string, any>,
  params: ComputerUseParams,
) {
  const adapter = resolveAdapterConfig(config);
  if (!adapter.command) return null;
  const result = await runCommand(adapter.command, adapter.args, {
    stdin: JSON.stringify(params),
    timeoutMs: params.timeoutMs || Number(config.timeoutMs) || undefined,
  });
  return {
    backend: "adapter-command",
    command: adapter.command,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

async function runFirstAvailable(
  candidates: Array<{ command: string; args: string[] }>,
  timeoutMs: number | undefined,
) {
  for (const candidate of candidates) {
    if (!(await commandExists(candidate.command))) continue;
    await runCommand(candidate.command, candidate.args, { timeoutMs });
    return candidate.command;
  }
  return "";
}

async function executeLinux(params: ComputerUseParams) {
  if (params.action === "screenshot") {
    const outPath = screenshotPath(params.path);
    const backend = await runFirstAvailable(
      [
        { command: "gnome-screenshot", args: ["-f", outPath] },
        { command: "grim", args: [outPath] },
        { command: "spectacle", args: ["-b", "-n", "-o", outPath] },
        { command: "scrot", args: [outPath] },
        { command: "import", args: ["-window", "root", outPath] },
      ],
      params.timeoutMs,
    );
    if (!backend)
      throw new Error("computer_use_screenshot_backend_unavailable");
    return { backend, action: "screenshot", path: outPath };
  }

  if (!(await commandExists("xdotool"))) {
    throw new Error("computer_use_xdotool_unavailable");
  }
  if (params.action === "key") {
    const key = text(params.key);
    if (!key) throw new Error("computer_use_key_required");
    await runCommand("xdotool", ["key", key], { timeoutMs: params.timeoutMs });
    return { backend: "xdotool", action: "key", key };
  }
  if (params.action === "type") {
    const value = String(params.text ?? "");
    if (!value) throw new Error("computer_use_text_required");
    await runCommand("xdotool", ["type", "--", value], {
      timeoutMs: params.timeoutMs,
    });
    return { backend: "xdotool", action: "type", chars: value.length };
  }
  if (params.action === "move") {
    assertCoordinates(params);
    await runCommand(
      "xdotool",
      ["mousemove", String(params.x), String(params.y)],
      {
        timeoutMs: params.timeoutMs,
      },
    );
    return { backend: "xdotool", action: "move", x: params.x, y: params.y };
  }
  if (typeof params.x === "number" && typeof params.y === "number") {
    await runCommand(
      "xdotool",
      ["mousemove", String(params.x), String(params.y)],
      {
        timeoutMs: params.timeoutMs,
      },
    );
  }
  const button = Math.max(1, Math.floor(Number(params.button || 1)));
  await runCommand("xdotool", ["click", String(button)], {
    timeoutMs: params.timeoutMs,
  });
  return { backend: "xdotool", action: "click", button };
}

function osascriptString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function ensureCliclick(
  config: Record<string, any>,
  timeoutMs: number | undefined,
) {
  if (await commandExists("cliclick")) return "cliclick";
  if (config.allowInstall === true && (await commandExists("brew"))) {
    await runCommand("brew", ["install", "cliclick"], { timeoutMs });
    if (await commandExists("cliclick")) return "cliclick";
  }
  throw new Error("computer_use_cliclick_unavailable");
}

async function executeMac(
  config: Record<string, any>,
  params: ComputerUseParams,
) {
  if (params.action === "screenshot") {
    const outPath = screenshotPath(params.path);
    await runCommand("screencapture", ["-x", outPath], {
      timeoutMs: params.timeoutMs,
    });
    return { backend: "screencapture", action: "screenshot", path: outPath };
  }
  if (params.action === "type") {
    const value = String(params.text ?? "");
    if (!value) throw new Error("computer_use_text_required");
    await runCommand(
      "osascript",
      [
        "-e",
        `tell application "System Events" to keystroke "${osascriptString(value)}"`,
      ],
      { timeoutMs: params.timeoutMs },
    );
    return { backend: "osascript", action: "type", chars: value.length };
  }
  if (params.action === "key") {
    const key = text(params.key);
    if (!key) throw new Error("computer_use_key_required");
    const code = macKeyCode(key);
    const script = code
      ? `tell application "System Events" to key code ${code}`
      : `tell application "System Events" to keystroke "${osascriptString(key)}"`;
    await runCommand("osascript", ["-e", script], {
      timeoutMs: params.timeoutMs,
    });
    return { backend: "osascript", action: "key", key };
  }
  const cliclick = await ensureCliclick(config, params.timeoutMs);
  if (params.action === "move") {
    assertCoordinates(params);
    await runCommand(cliclick, [`m:${params.x},${params.y}`], {
      timeoutMs: params.timeoutMs,
    });
    return { backend: "cliclick", action: "move", x: params.x, y: params.y };
  }
  assertCoordinates(params);
  await runCommand(cliclick, [`c:${params.x},${params.y}`], {
    timeoutMs: params.timeoutMs,
  });
  return { backend: "cliclick", action: "click", x: params.x, y: params.y };
}

function macKeyCode(key: string) {
  const map: Record<string, number> = {
    return: 36,
    enter: 36,
    tab: 48,
    escape: 53,
    esc: 53,
    space: 49,
    delete: 51,
    backspace: 51,
    up: 126,
    down: 125,
    left: 123,
    right: 124,
  };
  return map[key.toLowerCase()];
}

function psString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsKey(key: string) {
  const map: Record<string, string> = {
    return: "{ENTER}",
    enter: "{ENTER}",
    tab: "{TAB}",
    escape: "{ESC}",
    esc: "{ESC}",
    space: " ",
    delete: "{DEL}",
    backspace: "{BACKSPACE}",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
  };
  return map[key.toLowerCase()] || key;
}

async function runPowerShell(script: string, timeoutMs: number | undefined) {
  const command = (await commandExists("powershell.exe"))
    ? "powershell.exe"
    : "powershell";
  await runCommand(
    command,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs },
  );
}

async function executeWindows(params: ComputerUseParams) {
  if (params.action === "screenshot") {
    const outPath = screenshotPath(params.path);
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
      "$graphics = [System.Drawing.Graphics]::FromImage($bmp)",
      "$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
      `$bmp.Save(${psString(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      "$graphics.Dispose()",
      "$bmp.Dispose()",
    ].join("; ");
    await runPowerShell(script, params.timeoutMs);
    return { backend: "powershell", action: "screenshot", path: outPath };
  }
  if (params.action === "type" || params.action === "key") {
    const value =
      params.action === "type"
        ? String(params.text ?? "")
        : windowsKey(text(params.key));
    if (!value) throw new Error(`computer_use_${params.action}_required`);
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.SendKeys]::SendWait(${psString(value)})`,
    ].join("; ");
    await runPowerShell(script, params.timeoutMs);
    return {
      backend: "powershell",
      action: params.action,
      chars: params.action === "type" ? value.length : undefined,
      key: params.action === "key" ? params.key : undefined,
    };
  }
  const user32 = [
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class MouseApi {",
    '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
    '[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);',
    "}",
  ].join(" ");
  if (params.action === "move") {
    assertCoordinates(params);
    await runPowerShell(
      `Add-Type ${psString(user32)}; [MouseApi]::SetCursorPos(${params.x}, ${params.y}) | Out-Null`,
      params.timeoutMs,
    );
    return { backend: "powershell", action: "move", x: params.x, y: params.y };
  }
  assertCoordinates(params);
  await runPowerShell(
    `Add-Type ${psString(user32)}; [MouseApi]::SetCursorPos(${params.x}, ${params.y}) | Out-Null; [MouseApi]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); [MouseApi]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)`,
    params.timeoutMs,
  );
  return { backend: "powershell", action: "click", x: params.x, y: params.y };
}

function assertCoordinates(params: ComputerUseParams) {
  if (typeof params.x !== "number" || typeof params.y !== "number") {
    throw new Error("computer_use_coordinates_required");
  }
}

async function executeComputerUse(params: ComputerUseParams) {
  const config = readComputerUseConfig();
  const adapterResult = await runAdapter(config, params);
  if (adapterResult) return adapterResult;
  if (process.platform === "win32") return await executeWindows(params);
  if (process.platform === "darwin") return await executeMac(config, params);
  if (process.platform === "linux") return await executeLinux(params);
  throw new Error(`computer_use_backend_unavailable:${process.platform}`);
}

export default function computerUseExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "computer_use",
    label: "Computer Use",
    description:
      "Control the local computer through a platform adapter. This extension must be enabled explicitly through Pi's native extension config.",
    promptSnippet:
      "Use computer_use for enabled local OS actions: screenshots, key presses, typing, mouse movement, and clicks. Prefer a configured adapter command when available; otherwise use the platform backend.",
    parameters: ComputerUseParamsSchema,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params: ComputerUseParams,
      _signal,
      _onUpdate,
      _ctx,
    ) {
      const result = await executeComputerUse(params);
      return {
        content: [
          {
            type: "text",
            text: [
              `computer_use ${params.action}`,
              JSON.stringify(result, null, 2),
            ].join("\n"),
          },
        ],
        details: { action: params.action, result },
      };
    },
  });
}
