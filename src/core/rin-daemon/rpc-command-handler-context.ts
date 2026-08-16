import { ok } from "../rin-lib/rpc.js";
import type {
  RinRpcCommandEnvelope,
  RinRpcResponseEnvelope,
} from "../rin-lib/rpc-types.js";

export type RpcCommand = RinRpcCommandEnvelope;

export type RpcCommandRequest = {
  command: RpcCommand;
  id: string | undefined;
  type: string;
};

export function rpcDone(
  id: string | undefined,
  type: string,
  value?: unknown,
): RinRpcResponseEnvelope {
  return ok(id, type, value);
}

export async function rpcRun<Value, Projected = Value>(
  id: string | undefined,
  type: string,
  task: () => Value | PromiseLike<Value>,
  project?: (value: Value) => Projected,
): Promise<RinRpcResponseEnvelope> {
  const value = await task();
  return rpcDone(id, type, project ? project(value) : value);
}
