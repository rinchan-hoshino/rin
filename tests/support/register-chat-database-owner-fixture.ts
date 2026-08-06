import { register } from "node:module";

const databaseTarget = "/dist/core/chat/database.js";
const migrationTarget = "/dist/core/chat/database-install-migration.js";
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (url.endsWith(${JSON.stringify(databaseTarget)})) {
    return {
      ...loaded,
      source: String(loaded.source) + "\\nexport { requiredText as __rinOwnerRequiredText, setWalJournalMode as __rinOwnerSetWalJournalMode, validateCurrentChatAdmissionModel as __rinOwnerValidateCurrentChatAdmissionModel, normalizeChatState as __rinOwnerNormalizeChatState };\\n",
      shortCircuit: true,
    };
  }
  if (url.endsWith(${JSON.stringify(migrationTarget)})) {
    return {
      ...loaded,
      source: String(loaded.source) + "\\nexport { tableHasColumn as __rinOwnerTableHasColumn, terminalOutboxKindForInstall as __rinOwnerTerminalOutboxKindForInstall, hasAssistantReplyForInstall as __rinOwnerHasAssistantReplyForInstall, hasLaterHandledUserMessageForInstall as __rinOwnerHasLaterHandledUserMessageForInstall, rebuildChatDeliveryTablesV9 as __rinOwnerRebuildChatDeliveryTablesV9, assertNoActiveOldAdmissionOwner as __rinOwnerAssertNoActiveOldAdmissionOwner, assertNoUnfencedRunningTurns as __rinOwnerAssertNoUnfencedRunningTurns };\\n",
      shortCircuit: true,
    };
  }
  return loaded;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
