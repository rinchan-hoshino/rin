import { Text } from "@earendil-works/pi-tui";

export function updateItemToolText(
  text: string,
  context?: { lastComponent?: unknown },
) {
  const component =
    context?.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  component.setText(text);
  return component;
}

export function renderItemToolCall(
  toolName: string,
  args: any,
  theme: any,
  context: any,
) {
  const action = String(args?.action || "").trim();
  return updateItemToolText(
    context?.isPartial === false
      ? ""
      : theme.fg(
          "toolTitle",
          action ? `${toolName} ${action}` : `${toolName} …`,
        ),
    context,
  );
}

export function fallbackItemToolResult(value: any, context: any) {
  const text = value?.content?.[0];
  return updateItemToolText(text?.type === "text" ? text.text : "", context);
}
