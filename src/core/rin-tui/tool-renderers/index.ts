import { noteToolRenderer } from "./note.js";
import { recallToolRenderer } from "./recall.js";
import { todoToolRenderer } from "./todo.js";

const coreToolRenderers = new Map(
  [noteToolRenderer, recallToolRenderer, todoToolRenderer].map((renderer) => [
    renderer.name,
    renderer,
  ]),
);

export function getCoreToolRenderer(toolName: unknown) {
  return coreToolRenderers.get(String(toolName || "").trim());
}
