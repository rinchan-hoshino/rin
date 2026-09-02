import path from "node:path";
import { pathToFileURL } from "node:url";

const triggerPath = path.resolve(String(process.argv[2] || ""));
const triggerId = String(process.argv[3] || "").trim();
const stateDir = path.resolve(String(process.argv[4] || ""));
const controller = new AbortController();
let requestSequence = 0;
const pendingEmits = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void }
>();

function send(message: Record<string, unknown>) {
  if (typeof process.send !== "function") {
    throw new Error("nerve_trigger_ipc_unavailable");
  }
  process.send(message);
}

function abortError() {
  const error = new Error("nerve_trigger_aborted");
  error.name = "AbortError";
  return error;
}

async function sleepFor(milliseconds: number) {
  let remaining = Number(milliseconds);
  if (!Number.isFinite(remaining) || remaining < 0) {
    throw new Error("nerve_trigger_sleep_duration_invalid");
  }
  const maximumDelay = 2_147_000_000;
  while (remaining > 0) {
    if (controller.signal.aborted) throw abortError();
    const delay = Math.min(remaining, maximumDelay);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(done, delay);
      function done() {
        controller.signal.removeEventListener("abort", aborted);
        resolve();
      }
      function aborted() {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", aborted);
        reject(abortError());
      }
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    remaining -= delay;
  }
  if (controller.signal.aborted) throw abortError();
}

async function sleepUntil(time: string | Date) {
  const timestamp = time instanceof Date ? time.getTime() : Date.parse(time);
  if (!Number.isFinite(timestamp)) {
    throw new Error("nerve_trigger_sleep_time_invalid");
  }
  await sleepFor(Math.max(0, timestamp - Date.now()));
}

function emit(input: Record<string, unknown>) {
  if (controller.signal.aborted) return Promise.reject(abortError());
  const requestId = `${process.pid}:${++requestSequence}`;
  return new Promise<void>((resolve, reject) => {
    pendingEmits.set(requestId, { resolve, reject });
    send({ type: "emit", requestId, input });
  });
}

process.on("message", (message: any) => {
  if (message?.type === "abort") {
    controller.abort();
    return;
  }
  if (message?.type !== "emit_result") return;
  const pending = pendingEmits.get(String(message.requestId || ""));
  if (!pending) return;
  pendingEmits.delete(String(message.requestId));
  if (message.success) pending.resolve();
  else pending.reject(new Error(String(message.error || "nerve_emit_failed")));
});

async function main() {
  if (!triggerPath || !triggerId || !stateDir) {
    throw new Error("nerve_trigger_worker_arguments_required");
  }
  const imported = await import(
    `${pathToFileURL(triggerPath).href}?loaded=${Date.now()}`
  );
  if (typeof imported.start !== "function") {
    throw new Error(`nerve_trigger_start_export_required:${triggerId}`);
  }
  send({ type: "ready" });
  await imported.start({
    emit,
    signal: controller.signal,
    stateDir,
    triggerId,
    sleepFor,
    sleepUntil,
  });
  send({ type: "stopped" });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    if (controller.signal.aborted && error?.name === "AbortError") {
      process.exit(0);
      return;
    }
    try {
      send({
        type: "error",
        error: String(error?.stack || error?.message || error),
      });
    } catch {}
    process.exit(1);
  });
