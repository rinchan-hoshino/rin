import { recallToolRenderer } from "./recall.js";
import { todoToolRenderer } from "./todo.js";

const coreToolRenderers = new Map(
  [recallToolRenderer, todoToolRenderer].map((renderer) => [
    renderer.name,
    renderer,
  ]),
);

export function getCoreToolRenderer(toolName: unknown) {
  return coreToolRenderers.get(String(toolName || "").trim());
}
