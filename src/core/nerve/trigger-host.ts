import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { NerveStimulusInput, NerveTriggerStatus } from "./contracts.js";

const TRIGGER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type TriggerRecord = NerveTriggerStatus & { child?: ChildProcess };

function triggersRoot(agentDir: string) {
  return path.join(path.resolve(agentDir), "nerve", "triggers");
}

function statesRoot(agentDir: string) {
  return path.join(path.resolve(agentDir), "nerve", "state");
}

function triggerIdFromPath(filePath: string) {
  return path.basename(filePath, ".ts");
}

function requiredTriggerId(value: unknown) {
  const id = String(value ?? "");
  if (!TRIGGER_ID_PATTERN.test(id)) throw new Error("nerve_trigger_id_invalid");
  return id;
}

export function createNerveTriggerHost(options: {
  agentDir: string;
  emit: (input: NerveStimulusInput) => Promise<unknown>;
  onTriggerError?: (input: { id: string; error: string }) => void;
  workerPath: string;
}) {
  const triggerDir = triggersRoot(options.agentDir);
  const stateRoot = statesRoot(options.agentDir);
  const workerPath = path.resolve(options.workerPath);
  const records = new Map<string, TriggerRecord>();
  let started = false;

  const setRecord = (record: TriggerRecord) => {
    records.set(record.id, record);
  };

  const launch = async (idInput: string) => {
    const id = requiredTriggerId(idInput);
    const filePath = path.join(triggerDir, `${id}.ts`);
    if (!fs.existsSync(filePath)) return false;
    const stateDir = path.join(stateRoot, id);
    fs.mkdirSync(stateDir, { recursive: true });
    const child = fork(workerPath, [filePath, id, stateDir], {
      cwd: triggerDir,
      env: process.env,
      execArgv: [],
      silent: true,
      serialization: "json",
    });
    setRecord({ id, path: filePath, state: "starting", pid: child.pid, child });
    let reportedError = false;
    child.on("message", (message: any) => {
      const current = records.get(id);
      if (!current || current.child !== child) return;
      if (message?.type === "ready") {
        setRecord({ ...current, state: "running" });
        return;
      }
      if (message?.type === "stopped") {
        setRecord({ ...current, state: "stopped", child: undefined });
        return;
      }
      if (message?.type === "error") {
        reportedError = true;
        const error = String(message.error || "nerve_trigger_failed");
        setRecord({
          ...current,
          state: "failed",
          error,
          child: undefined,
        });
        options.onTriggerError?.({ id, error });
        return;
      }
      if (message?.type !== "emit") return;
      const requestId = String(message.requestId || "");
      const input = message.input || {};
      void options
        .emit(input)
        .then(() => {
          child.send?.({ type: "emit_result", requestId, success: true });
        })
        .catch((error) => {
          child.send?.({
            type: "emit_result",
            requestId,
            success: false,
            error: String(error?.message || error),
          });
        });
    });
    child.once("exit", (code, signal) => {
      const current = records.get(id);
      if (!current || current.child !== child) return;
      if (current.state === "stopped" || current.state === "failed") return;
      if (code === 0) {
        setRecord({ ...current, state: "stopped", child: undefined });
        return;
      }
      const error = `nerve_trigger_exit:${code ?? "null"}:${signal ?? "none"}`;
      setRecord({ ...current, state: "failed", error, child: undefined });
      if (!reportedError) options.onTriggerError?.({ id, error });
    });
    return true;
  };

  const stopRecord = async (record: TriggerRecord) => {
    const child = record.child;
    if (!child || child.exitCode !== null) return;
    child.send?.({ type: "abort" });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return {
    async start() {
      if (started) return;
      started = true;
      fs.mkdirSync(triggerDir, { recursive: true });
      fs.mkdirSync(stateRoot, { recursive: true });
      const packagePath = path.join(path.dirname(triggerDir), "package.json");
      if (!fs.existsSync(packagePath)) {
        fs.writeFileSync(packagePath, '{"type":"module"}\n', "utf8");
      }
      const files = fs
        .readdirSync(triggerDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name)
        .sort();
      for (const file of files) await launch(triggerIdFromPath(file));
    },
    async reload(idInput?: string) {
      if (!started) throw new Error("nerve_trigger_host_not_started");
      if (!idInput) {
        const ids = new Set([
          ...records.keys(),
          ...fs
            .readdirSync(triggerDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
            .map((entry) => triggerIdFromPath(entry.name)),
        ]);
        for (const id of [...ids].sort()) await this.reload(id);
        return;
      }
      const id = requiredTriggerId(idInput);
      const current = records.get(id);
      if (current) await stopRecord(current);
      records.delete(id);
      await launch(id);
    },
    async stop() {
      if (!started) return;
      started = false;
      await Promise.all(
        [...records.values()].map((record) => stopRecord(record)),
      );
      records.clear();
    },
    status() {
      return {
        triggers: [...records.values()]
          .map(({ child: _child, ...record }) => record)
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    },
  };
}

export type NerveTriggerHost = ReturnType<typeof createNerveTriggerHost>;
