import type { RinRpcResponseEnvelope } from "./rpc-types.js";

function normalizeResponseError(payload: unknown) {
  const message = String(
    (payload as any)?.message || (payload as any)?.error || payload || "",
  ).trim();
  return message || "rin_request_failed";
}

function buildResponseEnvelope(
  id: string | undefined,
  command: string,
  success: boolean,
): RinRpcResponseEnvelope {
  return { id, type: "response", command, success };
}

export function response(
  id: string | undefined,
  command: string,
  success: boolean,
  payload?: unknown,
): RinRpcResponseEnvelope {
  const base = buildResponseEnvelope(id, command, success);
  if (success) return payload === undefined ? base : { ...base, data: payload };
  return { ...base, error: normalizeResponseError(payload) };
}

export function ok(id: string | undefined, command: string, data?: unknown) {
  return response(id, command, true, data);
}

export function fail(id: string | undefined, command: string, error: unknown) {
  return response(id, command, false, error);
}
