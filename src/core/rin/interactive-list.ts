type InteractiveState = {
  selectedIndex: number;
  expanded: boolean;
};

export type InteractiveRenderResult = {
  content: string;
  itemCount: number;
};

type InteractiveListOptions = {
  intervalMs: number;
  render: (state: InteractiveState) => Promise<InteractiveRenderResult>;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isInteractiveTerminal(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
) {
  return Boolean(
    input.isTTY && output.isTTY && typeof input.setRawMode === "function",
  );
}

function classifyKey(data: Buffer | string) {
  const key = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
  if (key === "\u0003" || key === "q" || key === "Q") return "quit";
  if (key === "\r" || key === "\n" || key === " ") return "toggle";
  if (key === "\u001b") return "escape";
  if (key === "\u001b[A" || key === "k") return "up";
  if (key === "\u001b[B" || key === "j") return "down";
  if (key === "\u001b[5~") return "pageUp";
  if (key === "\u001b[6~") return "pageDown";
  if (key === "\u001b[H" || key === "\u001b[1~") return "home";
  if (key === "\u001b[F" || key === "\u001b[4~") return "end";
  return "unknown";
}

export async function runInteractiveList(options: InteractiveListOptions) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!isInteractiveTerminal(input, output)) return false;

  let running = true;
  let wake: (() => void) | undefined;
  let itemCount = 0;
  const state: InteractiveState = { selectedIndex: 0, expanded: false };
  const wasRaw = Boolean(input.isRaw);

  const requestRedraw = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };

  const onData = (data: Buffer | string) => {
    switch (classifyKey(data)) {
      case "quit":
        running = false;
        requestRedraw();
        break;
      case "toggle":
        state.expanded = !state.expanded;
        requestRedraw();
        break;
      case "escape":
        state.expanded = false;
        requestRedraw();
        break;
      case "up":
        state.selectedIndex = clamp(
          state.selectedIndex - 1,
          0,
          Math.max(0, itemCount - 1),
        );
        requestRedraw();
        break;
      case "down":
        state.selectedIndex = clamp(
          state.selectedIndex + 1,
          0,
          Math.max(0, itemCount - 1),
        );
        requestRedraw();
        break;
      case "pageUp":
        state.selectedIndex = clamp(
          state.selectedIndex - 10,
          0,
          Math.max(0, itemCount - 1),
        );
        requestRedraw();
        break;
      case "pageDown":
        state.selectedIndex = clamp(
          state.selectedIndex + 10,
          0,
          Math.max(0, itemCount - 1),
        );
        requestRedraw();
        break;
      case "home":
        state.selectedIndex = 0;
        requestRedraw();
        break;
      case "end":
        state.selectedIndex = Math.max(0, itemCount - 1);
        requestRedraw();
        break;
    }
  };

  const waitForRedraw = async () =>
    await Promise.race([
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
      new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs)),
    ]);

  try {
    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
    output.write("\u001b[?1049h\u001b[?25l");
    while (running) {
      const result = await options.render(state);
      itemCount = Math.max(0, Math.floor(Number(result.itemCount) || 0));
      state.selectedIndex = clamp(
        state.selectedIndex,
        0,
        Math.max(0, itemCount - 1),
      );
      output.write(`\u001b[2J\u001b[H${result.content}`);
      await waitForRedraw();
    }
  } finally {
    wake = undefined;
    input.off("data", onData);
    if (!wasRaw) input.setRawMode?.(false);
    output.write("\u001b[?25h\u001b[?1049l");
  }

  return true;
}
