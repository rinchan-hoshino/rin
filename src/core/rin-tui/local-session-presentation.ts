import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { getCoreToolRenderer } from "./tool-renderers/index.js";

const localPresentationSessions = new WeakSet<object>();

export function installLocalTuiPresentation(session: AgentSession) {
  if (localPresentationSessions.has(session)) return;
  const originalGetToolDefinition = session.getToolDefinition.bind(session);
  session.getToolDefinition = (name: string) => {
    const backendTool = originalGetToolDefinition(name);
    const renderer = getCoreToolRenderer(name);
    return backendTool && renderer
      ? { ...backendTool, ...renderer }
      : backendTool;
  };
  localPresentationSessions.add(session);
}

export function attachLocalTuiPresentation<T extends { session: AgentSession }>(
  runtime: T,
): T {
  installLocalTuiPresentation(runtime.session);
  return runtime;
}
