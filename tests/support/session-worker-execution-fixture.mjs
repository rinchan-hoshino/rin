import fs from "node:fs";
import process from "node:process";
import readline from "node:readline";
import { setImmediate, setTimeout } from "node:timers";

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

const optionsPath = readArg("--resource-options-file");
const options = optionsPath
  ? JSON.parse(fs.readFileSync(optionsPath, "utf8"))
  : {};
if (optionsPath) fs.rmSync(optionsPath, { force: true });
const initial = options.__rinInitialSession;
const sessionFile =
  initial?.kind === "open" ? initial.sessionFile : options.fixtureSessionFile;
const sessionId = "fixture-session";
if (options.fixtureIgnoreSigterm) process.on("SIGTERM", () => {});
const logPath = options.fixtureLogPath;
const log = (line) => fs.appendFileSync(logPath, `${line}\n`);
log(initial?.kind === "open" ? `open:${sessionFile}` : `create:${sessionFile}`);

function output(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    const respond = () => {
      if (options.fixtureStartupFailure) {
        output({
          type: "response",
          id: command.id,
          command: "get_state",
          success: false,
          error: "fixture startup failure",
        });
        return;
      }
      output({
        type: "response",
        id: command.id,
        command: "get_state",
        success: true,
        data: {
          ...(options.fixtureOmitSessionFile ? {} : { sessionFile }),
          sessionId,
          turnActive: false,
          isStreaming: false,
          isCompacting: false,
        },
      });
    };
    if (
      initial?.kind === "open" &&
      Number(options.fixtureRecoveryStartupDelayMs) > 0
    ) {
      setTimeout(respond, Number(options.fixtureRecoveryStartupDelayMs));
    } else {
      respond();
    }
    return;
  }
  if (command.type === "start_blocking_turn") {
    log("start-blocking");
    output({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data: {
        ...(options.fixtureOmitSessionFile ? {} : { sessionFile }),
        sessionId,
      },
    });
    if (!options.fixtureBlockWithoutTurn) {
      output({
        type: "rpc_turn_event",
        event: "start",
        requestTag: command.requestTag,
        turnGeneration: 1,
        ...(options.fixtureOmitSessionFile ? {} : { sessionFile }),
        sessionId,
      });
    }
    setImmediate(() => {
      while (true) fs.statSync(logPath);
    });
    return;
  }
  if (command.type === "abort_interrupted_turn") {
    log(`native-abort:${command.requestTag}`);
    output({ type: "agent_start", sessionFile, sessionId });
    output({
      type: "rpc_turn_event",
      event: "error",
      requestTag: command.requestTag,
      turnGeneration: 1,
      sessionFile,
      sessionId,
      error: "Operation aborted",
    });
    output({ type: "agent_end", sessionFile, sessionId });
    output({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data: { sessionFile, sessionId },
    });
    return;
  }
  if (command.type === "crash") {
    process.stderr.write("fixture execution stderr\n");
    process.stdout.write("fixture raw stdout\n");
    process.exit(7);
  }
  if (command.type === "abort") {
    log(`direct-abort:${command.id}`);
    if (options.fixtureAbortMode === "ack-delay") {
      output({
        type: "rpc_control_event",
        event: "abort_started",
        id: command.id,
      });
      setTimeout(() => {
        output({
          type: "response",
          id: command.id,
          command: command.type,
          success: true,
          data: { sessionFile, sessionId },
        });
      }, 150);
      return;
    }
    output({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data: { sessionFile, sessionId },
    });
    return;
  }
  output({
    type: "response",
    id: command.id,
    command: command.type,
    success: false,
    error: `unknown:${command.type}`,
  });
});
input.on("close", () => process.exit(0));
