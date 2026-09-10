import test from 'node:test';
import assert from 'node:assert/strict';
import { runUpdateMigrations } from '../src/install/migrations.mjs';

test('the legacy candidate entrypoint leaves private settings and services untouched', async () => {
  const options = new Proxy({}, {get() {throw new Error('Retired migration accessed private options');}});
  const result = await runUpdateMigrations(options);
  assert.deepEqual(result, {
    agentsChanged: false,
    obsoleteConfigRemoved: false,
    contextManagementMigrated: false,
  });
  assert.equal(result.nerve?.needsActivation, undefined);
});
