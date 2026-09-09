import test from 'node:test';
import assert from 'node:assert/strict';
import {allowed} from '../dist/chat/policy.js';
import {clearPrivateLikeCacheForTests, effectivePrivate, privateLikeFromProof, shouldProbePrivateLike} from '../dist/chat/private-like.js';

const adapter = {id: 'telegram-main', type: 'telegram', allowUsers: ['owner', 'trusted'], ownerUsers: ['owner'], dmOnly: true, requireMention: true};
const group = {id: 'm1', chatId: '-1001', userId: 'owner', kind: 'group', text: 'hello', mentioned: false};

test('private-like requires explicit owner plus a complete singleton human proof', () => {
  clearPrivateLikeCacheForTests();
  assert.equal(privateLikeFromProof(adapter, group, {complete: true, nonAgentUserIds: ['owner']}), true);
  assert.equal(effectivePrivate({...group, privateLike: true}), true);
  assert.equal(effectivePrivate(group), false);
  assert.equal(privateLikeFromProof({...adapter, ownerUsers: undefined}, group, {complete: true, nonAgentUserIds: ['owner']}), false);
  assert.equal(privateLikeFromProof(adapter, {...group, userId: 'trusted'}, {complete: true, nonAgentUserIds: ['trusted']}), false);
  assert.equal(privateLikeFromProof(adapter, group, {complete: false}), false);
  assert.equal(privateLikeFromProof(adapter, group, {complete: true, nonAgentUserIds: ['owner', 'someone-else']}), false);
});

test('private-like only caches negative proofs and expires them after ten minutes', () => {
  clearPrivateLikeCacheForTests();
  const now = 1_000;
  assert.equal(privateLikeFromProof(adapter, group, {complete: true, privateLike: false}, now), false);
  assert.equal(shouldProbePrivateLike(adapter, group, now + 1), false);
  assert.equal(shouldProbePrivateLike(adapter, group, now + 10 * 60_000), true);
  assert.equal(privateLikeFromProof(adapter, group, {complete: true, nonAgentUserIds: ['owner']}, now + 10 * 60_000), true);
  assert.equal(shouldProbePrivateLike(adapter, group, now + 10 * 60_000 + 1), true);
});

test('private-like keeps group transport semantics while applying dmOnly and mention policy', () => {
  assert.equal(allowed(adapter, group), false);
  assert.equal(allowed(adapter, {...group, privateLike: true}), true);
  assert.equal(allowed(adapter, {...group, privateLike: true, userId: 'trusted'}), false, 'allowUsers does not turn a non-owner into private-like');
  assert.equal(allowed(adapter, {...group, privateLike: true, userId: 'stranger'}), false);
});

test('an explicit owner proof may bind a DM-only group without pre-approving it', async () => {
  const {validateConfig} = await import('../dist/chat/policy.js');
  assert.doesNotThrow(() => validateConfig({adapters: [adapter], bindings: [{adapter: adapter.id, chatId: 'g', kind: 'group', threadId: 't', mirror: true}]}));
  assert.throws(() => validateConfig({adapters: [{...adapter, ownerUsers: []}], bindings: [{adapter: adapter.id, chatId: 'g', kind: 'group', threadId: 't', mirror: true}]}), /DM-only/);
});
