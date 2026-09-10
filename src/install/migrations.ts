/** Keep the upgrade handshake used by older CLIs without applying retired settings. */
export async function runUpdateMigrations(_options: unknown = {}) {
  return {
    agentsChanged: false,
    obsoleteConfigRemoved: false,
    contextManagementMigrated: false,
  };
}
