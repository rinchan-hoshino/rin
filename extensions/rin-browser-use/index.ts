import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const DEFAULT_AGENT_BROWSER_PACKAGE = "agent-browser";
const CONFIG_FILE_NAME = "rin-browser-use.json";

const BrowserUseParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("connect"),
    Type.Literal("open"),
    Type.Literal("snapshot"),
    Type.Literal("eval"),
    Type.Literal("click"),
    Type.Literal("type"),
    Type.Literal("fill"),
    Type.Literal("press"),
    Type.Literal("wait"),
    Type.Literal("screenshot"),
    Type.Literal("get"),
  ]),
  url: Type.Optional(Type.String({ description: "URL for open." })),
  endpoint: Type.Optional(
    Type.String({ description: "CDP endpoint or port for connect." }),
  ),
  selector: Type.Optional(
    Type.String({ description: "Selector or agent-browser @ref." }),
  ),
  text: Type.Optional(Type.String({ description: "Text for type/fill." })),
  key: Type.Optional(Type.String({ description: "Key name for press." })),
  script: Type.Optional(Type.String({ description: "JavaScript for eval." })),
  path: Type.Optional(
    Type.String({ description: "Output path for screenshot." }),
  ),
  what: Type.Optional(
    Type.String({
      description: "agent-browser get target such as text, title, url.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Action timeout in milliseconds." }),
  ),
});

type BrowserUseParams = {
  action:
    | "status"
    | "connect"
    | "open"
    | "snapshot"
    | "eval"
    | "click"
    | "type"
    | "fill"
    | "press"
    | "wait"
    | "screenshot"
    | "get";
  url?: string;
  endpoint?: string;
  selector?: string;
  text?: string;
  key?: string;
  script?: string;
  path?: string;
  what?: string;
  timeoutMs?: number;
};

function text(value: unknown) {
  return String(value ?? "").trim();
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

function readBrowserUseConfig() {
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
  timeoutMs: number | undefined,
) {
  return await new Promise<{ stdout: string; stderr: string; command: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(
        () => {
          child.kill("SIGTERM");
          reject(new Error("browser_use_timeout"));
        },
        Math.max(1, timeoutMs || 30_000),
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
          reject(new Error(stderr.trim() || `browser_use_exit_${code}`));
          return;
        }
        resolve({ stdout, stderr, command: [command, ...args].join(" ") });
      });
    },
  );
}

function agentBrowserArgs(params: BrowserUseParams) {
  const selector = text(params.selector);
  const action = params.action;
  if (action === "status") return ["get", "cdp-url"];
  if (action === "connect") {
    const endpoint = text(params.endpoint);
    if (!endpoint) throw new Error("browser_use_endpoint_required");
    return ["connect", endpoint];
  }
  if (action === "open") {
    const url = text(params.url);
    if (!url) throw new Error("browser_use_url_required");
    return ["open", url];
  }
  if (action === "snapshot") return ["snapshot"];
  if (action === "eval") {
    const script = text(params.script);
    if (!script) throw new Error("browser_use_script_required");
    return ["eval", script];
  }
  if (action === "click") {
    if (!selector) throw new Error("browser_use_selector_required");
    return ["click", selector];
  }
  if (action === "type") {
    const value = String(params.text ?? "");
    if (!value) throw new Error("browser_use_text_required");
    return selector ? ["type", selector, value] : ["keyboard", "type", value];
  }
  if (action === "fill") {
    const value = String(params.text ?? "");
    if (!selector) throw new Error("browser_use_selector_required");
    return ["fill", selector, value];
  }
  if (action === "press") {
    const key = text(params.key);
    if (!key) throw new Error("browser_use_key_required");
    return ["press", key];
  }
  if (action === "wait") {
    return ["wait", selector || String(Math.max(1, params.timeoutMs || 1000))];
  }
  if (action === "screenshot") {
    const outPath = text(params.path);
    return outPath ? ["screenshot", outPath] : ["screenshot"];
  }
  const what = text(params.what) || "text";
  return selector ? ["get", what, selector] : ["get", what];
}

async function runAgentBrowser(args: string[], timeoutMs: number | undefined) {
  const config = readBrowserUseConfig();
  const configuredCommand = text(config.command);
  const configuredArgs = parseArgsValue(config.args);
  const packageName = text(config.package) || DEFAULT_AGENT_BROWSER_PACKAGE;
  if (configuredCommand) {
    return await runCommand(
      configuredCommand,
      [...configuredArgs, ...args],
      timeoutMs || Number(config.timeoutMs) || undefined,
    );
  }
  if (await commandExists("agent-browser")) {
    return await runCommand(
      "agent-browser",
      args,
      timeoutMs || Number(config.timeoutMs) || undefined,
    );
  }
  return await runCommand(
    "npx",
    ["-y", packageName, ...args],
    timeoutMs || Number(config.timeoutMs) || undefined,
  );
}

export default function browserUseExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_use",
    label: "Browser Use",
    description:
      "Control a browser through the external agent-browser CLI. This extension must be enabled explicitly through Pi's native extension config.",
    promptSnippet:
      "Use browser_use for browser automation through agent-browser: open pages, inspect snapshots, click refs/selectors, type, press keys, evaluate JavaScript, and take screenshots.",
    parameters: BrowserUseParamsSchema,
    async execute(
      _toolCallId,
      params: BrowserUseParams,
      _signal,
      _onUpdate,
      _ctx,
    ) {
      const args = agentBrowserArgs(params);
      const result = await runAgentBrowser(args, params.timeoutMs);
      return {
        content: [
          {
            type: "text",
            text: [
              `browser_use ${params.action}`,
              `command: ${result.command}`,
              result.stdout.trim()
                ? `stdout:\n${result.stdout.trim()}`
                : "stdout: <empty>",
              result.stderr.trim()
                ? `stderr:\n${result.stderr.trim()}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: { action: params.action, command: result.command },
      };
    },
  });
}
