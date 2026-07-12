import { isJsonRecord } from "../json-utils.js";
import type { RinRpcResponse } from "./types.js";

export type RinRpcInbound = Record<string, unknown>;

export function normalizeRinRpcInbound(value: unknown): RinRpcInbound | null {
  return isJsonRecord(value) ? value : null;
}

export function isRinRpcResponse(value: unknown): value is RinRpcResponse {
  const record = normalizeRinRpcInbound(value);
  return Boolean(
    record &&
    record.type === "response" &&
    typeof record.id === "string" &&
    record.id,
  );
}

export function readRinRpcResponseData(response: unknown): unknown {
  const record = normalizeRinRpcInbound(response);
  if (!record || record.success !== true) {
    throw new Error(String(record?.error || "rin_request_failed"));
  }
  return record.data;
}
