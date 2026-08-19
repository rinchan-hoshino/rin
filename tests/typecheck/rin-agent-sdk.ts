import type { ChatSendOptions } from "../../src/core/rin-agent-sdk/index.js";

const textMessage: ChatSendOptions = {
  chatKey: "discord/channel",
  text: "hello",
};
const richMessage: ChatSendOptions = {
  chatKey: "discord/channel",
  parts: [{ type: "text", text: "hello" }],
  deliveryKind: "final",
  requestId: "request-1",
};
const unsupportedContent: ChatSendOptions = {
  chatKey: "discord/channel",
  // @ts-expect-error content is not a Chat outbox payload field
  content: "hello",
};

void textMessage;
void richMessage;
void unsupportedContent;
