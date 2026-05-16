export function nowIso() {
  return new Date().toISOString();
}

export function nowFileTimestamp() {
  return nowIso().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}
