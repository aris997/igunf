import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { bigCandidates, emptyDataset, enqueue, succeededSinceSnapshot } from "../src/domain.ts";
import { importFiles, parseBackup } from "../src/importer.ts";

const snapshotAt = "2026-09-10T00:00:00.000Z";
const options = { owner: "me", snapshotAt, followersComplete: true, followingComplete: true };
const json = (name: string, value: unknown): { name: string; data: Uint8Array } => ({ name, data: strToU8(JSON.stringify(value)) });
const entries = (...names: string[]): unknown[] => names.map((name) => ({ title: "", string_list_data: [{ value: name, href: `https://www.instagram.com/${name}/`, timestamp: 1_700_000_000 }] }));
const followers = (...names: string[]): { name: string; data: Uint8Array } => json("followers_1.json", entries(...names));
const following = (...names: string[]): { name: string; data: Uint8Array } => json("following.json", { relationships_following: entries(...names) });

test("imports official follower shards and current title-only following entries", async () => {
  const data = await importFiles([
    followers("friend"), json("followers_2.json", entries("visitor")),
    json("following.json", { relationships_following: [{ title: "friend", string_list_data: [{ href: "https://www.instagram.com/_u/friend/", timestamp: 1_700_000_000 }] }] }),
  ], options);
  assert.deepEqual(data.followers, ["friend", "visitor"]);
  assert.deepEqual(data.following, ["friend"]);
  assert.equal(data.edges.length, 3);
  assert.deepEqual(data.edges[0], { from: "friend", to: "me", observedAt: snapshotAt, source: "export" });
});

test("accepts complete empty lists only with actual files and explicit attestation", async () => {
  const data = await importFiles([followers(), following()], options);
  assert.equal(data.followersComplete, true);
  assert.deepEqual(data.following, []);
  const partial = await importFiles([following("large")], { ...options, followersComplete: false });
  assert.equal(partial.followersComplete, false);
  await assert.rejects(importFiles([following("large")], options), /without a followers file/);
  await assert.rejects(importFiles([followers("friend")], options), /without following.json/);
});

test("does not infer list completeness from filenames", async () => {
  const data = await importFiles([followers("friend"), following("large")], { ...options, followersComplete: false, followingComplete: false });
  assert.equal(data.followersComplete, false);
  assert.equal(data.followingComplete, false);
});

test("rejects shard gaps, mixed export filenames, duplicate lists and duplicate account records", async () => {
  await assert.rejects(importFiles([followers("friend"), json("followers_3.json", entries("visitor")), following()], options), /Missing followers_2/);
  await assert.rejects(importFiles([json("followers.json", entries()), json("followers_2.json", entries()), following()], options), /Do not mix/);
  await assert.rejects(importFiles([followers(), following(), following()], options), /Multiple following/);
  await assert.rejects(importFiles([followers("friend", "friend"), following()], options), /Duplicate accounts/);
  await assert.rejects(importFiles([json("followers_0.json", entries()), followers(), following()], options), /Invalid follower shard/);
  await assert.rejects(importFiles([json("unrelated.json", [])], options), /No followers_1/);
});

test("rejects malformed entries, list shapes and conflicting links", async () => {
  await assert.rejects(importFiles([json("followers_1.json", {}), following()], options), /must be a list/);
  await assert.rejects(importFiles([json("followers_1.json", [{ string_list_data: [] }]), following()], options), /without a username/);
  await assert.rejects(importFiles([json("followers_1.json", [{ string_list_data: [{ value: "friend", href: "https://evil.example/friend" }] }]), following()], options), /mismatched/);
  await assert.rejects(importFiles([json("followers_1.json", [{ title: "other", string_list_data: [{ value: "friend" }] }]), following()], options), /conflicting/);
  await assert.rejects(importFiles([json("followers_1.json", [{ title: "friend", string_list_data: [{ value: 123 }] }]), following()], options), /malformed username/);
  await assert.rejects(importFiles([followers("me"), following()], options), /owner/);
});

test("rejects prototype pollution in raw JSON and backup records", async () => {
  await assert.rejects(importFiles([{ name: "followers_1.json", data: strToU8('[{"__proto__":{"polluted":true}}]') }, following()], options), /Unsafe JSON/);
  await assert.rejects(importFiles([followers("__proto__"), following()], options), /Invalid Instagram/);
  assert.throws(() => parseBackup('{"__proto__":{}}'), /Unsafe JSON/);
  assert.equal(Object.hasOwn({}, "polluted"), false);
});

test("ZIP import finds relationship files inside export folders and ignores unrelated content", async () => {
  const archive = zipSync({
    "connections/followers_and_following/followers_1.json": followers("friend").data,
    "connections/followers_and_following/following.json": following("friend", "large").data,
    "content/posts.json": strToU8("ignored"),
  });
  const data = await importFiles([{ name: "instagram.zip", data: archive }], options);
  assert.deepEqual(data.following, ["friend", "large"]);
});

test("ZIP import rejects unsafe paths, truncated archives and excessive inflated content", async () => {
  const traversal = zipSync({ "../followers_1.json": followers().data, "following.json": following().data });
  await assert.rejects(importFiles([{ name: "unsafe.zip", data: traversal }], options), /unsafe file path/);
  const valid = zipSync({ "followers_1.json": followers().data, "following.json": following().data });
  await assert.rejects(importFiles([{ name: "truncated.zip", data: valid.subarray(0, -10) }], options), /incomplete|truncated/);
  const bomb = zipSync({ "followers_1.json": new Uint8Array(20 * 1024 * 1024 + 1) });
  await assert.rejects(importFiles([{ name: "bomb.zip", data: bomb }], options), /size limits/);
  const forged = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
  forged.setUint32(22, 1, true);
  for (let offset = 0; offset < bomb.length - 46; offset++) {
    if (forged.getUint32(offset, true) === 0x02014b50) { forged.setUint32(offset + 24, 1, true); break; }
  }
  await assert.rejects(importFiles([{ name: "forged-size.zip", data: bomb }], options), /expanded data limit/);
});

test("reimport replaces export facts, retains same-owner evidence and decisions, and drops pending work", async () => {
  const prior = await importFiles([followers("oldfriend"), following("large")], options);
  prior.friends = ["oldfriend"];
  prior.decisions.large = { kind: "keep", updatedAt: snapshotAt };
  prior.profiles.large!.followerCount = { value: 25_000, exact: true, source: "manual", observedAt: snapshotAt };
  prior.edges.push({ from: "oldfriend", to: "large", source: "manual", observedAt: snapshotAt });
  prior.queue = [
    { id: "1", username: "large", reason: "review", status: "pending", addedAt: snapshotAt },
    { id: "2", username: "past", reason: "review", status: "succeeded", addedAt: snapshotAt },
  ];
  const data = await importFiles([followers("newfriend"), following("large")], options, prior);
  assert.deepEqual(data.followers, ["newfriend"]);
  assert.equal(data.edges.some((edge) => edge.from === "oldfriend" && edge.source === "export"), false);
  assert.equal(data.edges.some((edge) => edge.from === "oldfriend" && edge.source === "manual"), true);
  assert.deepEqual(data.friends, ["oldfriend"]);
  assert.equal(data.decisions.large?.kind, "keep");
  assert.equal(data.profiles.large?.followerCount?.value, 25_000);
  assert.deepEqual(data.queue.map((item) => item.id), ["2"]);
  const otherOwner = await importFiles([followers(), following()], { ...options, owner: "other" }, prior);
  assert.equal(Object.keys(otherOwner.decisions).length, 0);
  assert.equal(otherOwner.queue.length, 0);
});

test("backup validates its schema and never restores executable pending or running work", async () => {
  const data = await importFiles([followers("friend"), following("large")], options);
  data.queue = [
    { id: "1", username: "large", reason: "big", status: "running", addedAt: snapshotAt },
    { id: "2", username: "past", reason: "review", status: "succeeded", addedAt: snapshotAt },
  ];
  const restored = parseBackup(JSON.stringify(data));
  assert.deepEqual(restored.queue.map((item) => item.id), ["2"]);
  assert.deepEqual(restored.following, ["large"]);
  assert.throws(() => parseBackup(JSON.stringify({ ...data, threshold: -1 })), /nonnegative/);
  assert.throws(() => parseBackup(JSON.stringify({ ...data, followersComplete: "true" })), /true or false/);
  assert.throws(() => parseBackup(JSON.stringify({ ...data, schemaVersion: 2 })), /schema/);
  assert.throws(() => parseBackup(JSON.stringify({ ...data, profiles: { large: { username: "other" } } })), /does not match/);
});

test("a newer import proving an account was followed again preserves audit and permits a new queue action", async () => {
  const recent = new Date(Date.now() - 1_000).toISOString();
  const earlier = new Date(Date.now() - 10_000).toISOString();
  const prior = await importFiles([followers(), following("large")], { ...options, snapshotAt: earlier });
  prior.profiles.large!.followerCount = { value: 30_001, exact: true, source: "manual", observedAt: recent };
  prior.queue = [{ id: "old-success", username: "large", reason: "big", status: "succeeded", addedAt: earlier, finishedAt: earlier }];
  assert.equal(succeededSinceSnapshot(prior, "large"), true);
  const imported = await importFiles([followers(), following("large")], { ...options, snapshotAt: recent }, prior);
  assert.equal(imported.queue[0]?.id, "old-success");
  assert.equal(succeededSinceSnapshot(imported, "large"), false);
  assert.deepEqual(bigCandidates(imported), ["large"]);
  const planned = enqueue(imported, ["large"], "big");
  assert.equal(planned.queue.length, 2);
  assert.equal(planned.queue[1]?.status, "pending");
});

test("reimport reconciles older owner edges only when the relevant relationship list is complete", async () => {
  const earlier = "2026-09-08T00:00:00.000Z";
  const later = "2026-09-10T01:00:00.000Z";
  const prior = emptyDataset("me");
  prior.edges = [
    { from: "old_follower", to: "me", source: "manual", observedAt: earlier },
    { from: "me", to: "old_following", source: "profile", observedAt: earlier },
    { from: "new_follower", to: "me", source: "profile", observedAt: later },
    { from: "friend", to: "large", source: "manual", observedAt: earlier },
  ];
  const complete = await importFiles([followers(), following()], options, prior);
  assert.deepEqual(complete.edges.map((edge) => edge.from), ["new_follower", "friend"]);
  const incompleteFollowers = await importFiles([following()], { ...options, followersComplete: false }, prior);
  assert.deepEqual(incompleteFollowers.edges.map((edge) => edge.from), ["old_follower", "new_follower", "friend"]);
  const incompleteFollowing = await importFiles([followers()], { ...options, followingComplete: false }, prior);
  assert.deepEqual(incompleteFollowing.edges.map((edge) => edge.from), ["me", "new_follower", "friend"]);
});

test("backup rejects fabricated export graph edges and unsafe count types", () => {
  const data = emptyDataset("me");
  data.edges = [{ from: "random", to: "me", source: "export", observedAt: snapshotAt }];
  assert.throws(() => parseBackup(JSON.stringify(data)), /contradicts/);
  data.edges = [];
  data.profiles.large = { username: "large", followerCount: { value: Number.NaN, exact: true, source: "manual", observedAt: snapshotAt } };
  assert.throws(() => parseBackup(JSON.stringify(data)), /nonnegative/);
});
