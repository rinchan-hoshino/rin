import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyStoredMessage,
  completeEmittingBatch,
  createAttentionState,
  normalizeAttentionState,
  enqueueAttention,
  prepareDueBatch,
} from "../src/attention.mjs";

const ownerId = "owner-id";
const now = Date.parse("2026-09-04T12:01:23.000Z");

function message(overrides = {}) {
  return {
    id: "message-a",
    messageId: "platform-a",
    platform: "discord",
    platformInstance: "bot-id",
    chatKey: "discord/bot-id:ambient-room",
    chatType: "group",
    role: "user",
    userId: "someone",
    trust: "USER",
    disposition: "record_only",
    receivedAt: "2026-09-04T12:01:23.000Z",
    ...overrides,
  };
}

test("ordinary owner messages batch briefly while idle and have a five minute busy deadline", () => {
  const classified = classifyStoredMessage(message({ userId: ownerId, trust: "OWNER" }), {
    ownerUserIds: new Set([ownerId]),
    mirrorDiscordChannelIds: new Set(),
    ambientWindowMs: 15 * 60_000,
  });
  assert.equal(classified.priority,60);assert.equal(classified.reason,"owner");assert.equal(classified.idleOnly,false);
  assert.equal(classified.nextCheckAt,"2026-09-04T12:01:53.000Z");
  assert.equal(classified.latestCheckAt,"2026-09-04T12:06:23.000Z");
});

test("an exact owner-note chat exclusion suppresses even owner messages", () => {
  const classified = classifyStoredMessage(message({ userId: ownerId, trust: "OWNER" }), {
    ownerUserIds: new Set([ownerId]),
    mirrorDiscordChannelIds: new Set(),
    ignoredChatKeys: new Set(["discord/bot-id:ambient-room"]),
    ambientWindowMs: 15 * 60_000,
  });
  assert.equal(classified, undefined);
});

test("ambient record-only messages batch at the next fixed window", () => {
  const classified = classifyStoredMessage(message(), {
    ownerUserIds: new Set([ownerId]),
    mirrorDiscordChannelIds: new Set(),
    ambientWindowMs: 15 * 60_000,
  });
  assert.equal(classified.priority, 20);
  assert.equal(classified.reason, "ambient");
  assert.equal(classified.nextCheckAt, "2026-09-04T12:15:00.000Z");
});

test("native actionable, non-user, and Discord QQ mirrors never create duplicate stimuli", () => {
  const options = {
    ownerUserIds: new Set([ownerId]),
    mirrorDiscordChannelIds: new Set(["mirror-room"]),
    ambientWindowMs: 15 * 60_000,
  };
  assert.equal(classifyStoredMessage(message({ disposition: "actionable" }), options), undefined);
  assert.equal(classifyStoredMessage(message({ role: "assistant" }), options), undefined);
  assert.equal(
    classifyStoredMessage(
      message({ chatKey: "discord/bot-id:mirror-room" }),
      options,
    ),
    undefined,
  );
  assert.ok(
    classifyStoredMessage(
      message({ platform: "onebot", chatKey: "onebot/onebot-id:mirror-room" }),
      options,
    ),
  );
});

test("pending messages dedupe by canonical Chat id and emit one stable recoverable batch", () => {
  const state = createAttentionState("seed-id");
  const ambient = classifyStoredMessage(message(), {
    ownerUserIds: new Set([ownerId]),
    mirrorDiscordChannelIds: new Set(),
    ambientWindowMs: 15 * 60_000,
  });
  enqueueAttention(state, ambient);
  enqueueAttention(state, ambient);
  assert.equal(state.pending.length, 1);
  assert.equal(prepareDueBatch(state, now), undefined);

  const dueAt = Date.parse("2026-09-04T12:15:00.000Z");
  const batch = prepareDueBatch(state, dueAt);
  assert.equal(batch.items.length, 1);
  assert.equal(batch.maxPriority, 20);
  assert.match(batch.dedupeKey, /^chat-attention:[a-f0-9]{64}$/);
  assert.equal(state.pending.length, 1);
  assert.deepEqual(prepareDueBatch(state, dueAt), batch);

  completeEmittingBatch(state, batch.id);
  assert.equal(state.emitting, undefined);
  assert.equal(prepareDueBatch(state,dueAt),undefined);
});

test("owner urgency requires both trusted identity and exact owner id", () => {
  const options = {
    ownerUserIds: new Set([ownerId]),
    mirrorDiscordChannelIds: new Set(),
    ambientWindowMs: 15 * 60_000,
  };
  assert.equal(classifyStoredMessage(message({ userId: ownerId }), options).reason, "ambient");
  assert.equal(classifyStoredMessage(message({ trust: "OWNER" }), options).reason, "ambient");
});

test("fixed-window boundary is due immediately without pulling later ambient messages forward", () => {
  const options = {
    ownerUserIds: new Set([ownerId]),
    mirrorDiscordChannelIds: new Set(),
    ambientWindowMs: 15 * 60_000,
  };
  const state = createAttentionState();
  enqueueAttention(state, classifyStoredMessage(message({ id: "boundary", receivedAt: "2026-09-04T12:15:00.000Z" }), options));
  enqueueAttention(state, classifyStoredMessage(message({ id: "later", receivedAt: "2026-09-04T12:15:00.001Z" }), options));
  const batch = prepareDueBatch(state, Date.parse("2026-09-04T12:15:00.000Z"));
  assert.deepEqual(batch.items.map(item => item.messageId), ["boundary"]);
  assert.deepEqual(state.pending.map(item => item.messageId), ["boundary","later"]);
  enqueueAttention(state, batch.items[0]);
  assert.equal(state.pending.length, 2);
  completeEmittingBatch(state, "wrong-batch");
  assert.equal(state.emitting.id, batch.id);
});

test("busy work defers ordinary owner messages but mentions use a short safety boundary",()=>{
  const options={ownerUserIds:new Set([ownerId]),mirrorDiscordChannelIds:new Set(),ambientWindowMs:900000};
  const state=createAttentionState();
  enqueueAttention(state,classifyStoredMessage(message({id:'ordinary',userId:ownerId,trust:'OWNER'}),options));
  assert.equal(prepareDueBatch(state,Date.parse('2026-09-04T12:01:53Z'),{active:true}),undefined);
  assert.equal(prepareDueBatch(state,Date.parse('2026-09-04T12:06:23Z'),{active:true}).items[0].messageId,'ordinary');
  const urgent=createAttentionState();
  enqueueAttention(urgent,classifyStoredMessage(message({id:'mention',userId:ownerId,trust:'OWNER',mentionedBot:true}),options));
  assert.equal(prepareDueBatch(urgent,Date.parse('2026-09-04T12:01:52Z'),{active:true}),undefined);
  assert.equal(prepareDueBatch(urgent,Date.parse('2026-09-04T12:01:53Z'),{active:true}).maxPriority,100);
});

test("version one state migrates without restoring immediate owner steering",()=>{
  const state=normalizeAttentionState({version:1,pending:[{messageId:'old',chatKey:'discord/bot:room',priority:100,reason:'owner',nextCheckAt:'2026-09-04T12:01:23Z'}]});
  assert.equal(state.version,2);assert.deepEqual(state.chats,{});assert.equal(state.pending[0].priority,60);
  assert.equal(state.pending[0].latestCheckAt,'2026-09-04T12:06:23.000Z');
});

test('a non-owner mention and an awaited ambient reply bypass the ambient fixed window',()=>{
  const options={ownerUserIds:new Set([ownerId]),mirrorDiscordChannelIds:new Set(),ambientWindowMs:900000};
  for(const extra of [{mentionedBot:true},{awaitingReply:true}]) {
    const item=classifyStoredMessage(message({mentionedBot:extra.mentionedBot===true}),{...options,awaitingReply:extra.awaitingReply===true});
    assert.equal(item.nextCheckAt,message().receivedAt);
    const state=createAttentionState();enqueueAttention(state,item);
    assert.equal(prepareDueBatch(state,now+30000,{active:true}).items.length,1);
  }
});
