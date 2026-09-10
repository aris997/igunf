import assert from "node:assert/strict";
import test from "node:test";
import { applyObservation, bigCandidates, emptyDataset, enqueue, isFresh, normalizeUsername, relationship, sharedFriends, succeededSinceSnapshot } from "../src/domain.ts";
import type { Dataset } from "../src/types.ts";

const now = new Date("2026-09-10T12:00:00.000Z");
const fresh = now.toISOString();
function dataset(): Dataset {
  return { ...emptyDataset("me"), snapshotAt: fresh, followersComplete: true, followingComplete: true, followers: ["friend"], following: ["friend", "large", "small"] };
}

test("normalizes Instagram names and rejects unsafe or non-account inputs", () => {
  assert.equal(normalizeUsername(" @Good.Name_1 "), "good.name_1");
  for (const input of ["", ".", "..", "has spaces", "user/path", "__proto__", "Constructor", "prototype", "a".repeat(31)]) assert.throws(() => normalizeUsername(input));
});

test("non-followback is established only by both complete lists", () => {
  const data = dataset();
  assert.equal(relationship(data, "large"), "not-following-back");
  assert.equal(relationship({ ...data, followersComplete: false }, "large"), "unknown");
  assert.equal(relationship({ ...data, followingComplete: false }, "large"), "unknown");
  assert.equal(relationship({ ...data, followingComplete: false, followersComplete: false }, "friend"), "mutual");
  assert.equal(relationship({ ...data, followers: ["visitor"] }, "visitor"), "follower-only");
  assert.equal(relationship({ ...data, followers: ["visitor"], followingComplete: false }, "visitor"), "unknown");
});

test("newer positive follows-you evidence prevents nonreciprocal selection and queueing", () => {
  const data = dataset();
  data.snapshotAt = new Date(Date.now() - 1_000).toISOString();
  const observationTime = new Date().toISOString();
  data.profiles.large = { username: "large", followerCount: { value: 30_001, exact: true, source: "manual", observedAt: observationTime } };
  data.edges = [{ from: "large", to: "me", source: "profile", observedAt: observationTime }];
  assert.equal(relationship(data, "large"), "mutual");
  assert.deepEqual(bigCandidates(data), []);
  assert.throws(() => enqueue(data, ["large"], "review"), /no longer eligible/);
  data.edges[0]!.observedAt = new Date(Date.now() - 2_000).toISOString();
  assert.equal(relationship(data, "large"), "not-following-back");
  assert.deepEqual(bigCandidates(data), ["large"]);
});

test("shared friends use directed observed connections, never transitive or reverse guesses", () => {
  const data = dataset();
  data.friends = ["friend", "reverse", "friend2"];
  data.edges = [
    { from: "friend", to: "large", source: "profile", observedAt: fresh },
    { from: "friend", to: "large", source: "manual", observedAt: fresh },
    { from: "large", to: "reverse", source: "profile", observedAt: fresh },
    { from: "unmarked", to: "large", source: "profile", observedAt: fresh },
    { from: "friend2", to: "friend", source: "profile", observedAt: fresh },
  ];
  assert.deepEqual(sharedFriends(data, "large"), ["friend"]);
});

test("freshness includes exactly seven days and excludes future or invalid dates", () => {
  assert.equal(isFresh("2026-09-03T12:00:00.000Z", now), true);
  assert.equal(isFresh("2026-09-03T11:59:59.999Z", now), false);
  assert.equal(isFresh("2026-09-10T12:00:00.001Z", now), false);
  assert.equal(isFresh("unknown", now), false);
});

test("big selection requires exact fresh counts above the threshold and ignores keep/friend exemptions", () => {
  const data = dataset();
  data.friends = ["large"];
  data.decisions.large = { kind: "keep", updatedAt: fresh };
  data.profiles.large = { username: "large", followerCount: { value: 20_001, exact: true, observedAt: fresh, source: "manual" } };
  data.profiles.small = { username: "small", followerCount: { value: 20_000, exact: true, observedAt: fresh, source: "profile" } };
  data.profiles.friend = { username: "friend", followerCount: { value: 1_000_000, exact: true, observedAt: fresh, source: "profile" } };
  assert.deepEqual(bigCandidates(data, now), ["large"]);
  data.profiles.large.followerCount!.exact = false;
  assert.deepEqual(bigCandidates(data, now), []);
  data.profiles.large.followerCount!.exact = true;
  data.profiles.large.followerCount!.observedAt = "2026-09-02T12:00:00.000Z";
  assert.deepEqual(bigCandidates(data, now), []);
});

test("big selection rejects stale snapshots, unknown relationships and succeeded accounts", () => {
  const data = dataset();
  data.profiles.large = { username: "large", followerCount: { value: 99_999, exact: true, observedAt: fresh, source: "profile" } };
  assert.deepEqual(bigCandidates({ ...data, snapshotAt: "2026-08-01T00:00:00.000Z" }, now), []);
  assert.deepEqual(bigCandidates({ ...data, followersComplete: false }, now), []);
  data.queue.push({ id: "done", username: "large", reason: "big", status: "succeeded", addedAt: fresh });
  assert.deepEqual(bigCandidates(data, now), []);
});

test("historical successes suppress actions only since the current snapshot", () => {
  const data = dataset();
  data.queue = [{ id: "past", username: "large", reason: "big", status: "succeeded", addedAt: "2026-09-01T00:00:00.000Z", finishedAt: "2026-09-02T00:00:00.000Z" }];
  assert.equal(succeededSinceSnapshot(data, "large"), false);
  data.queue[0]!.finishedAt = fresh;
  assert.equal(succeededSinceSnapshot(data, "large"), true);
  delete data.queue[0]!.finishedAt;
  assert.equal(succeededSinceSnapshot(data, "large"), false);
  data.queue[0]!.addedAt = fresh;
  assert.equal(succeededSinceSnapshot(data, "large"), true);
});

test("queue selection is atomic, immutable and deduplicated", () => {
  const data = { ...dataset(), snapshotAt: new Date().toISOString() };
  assert.throws(() => enqueue(data, ["large", "friend"], "review"), /no longer eligible/);
  assert.equal(data.queue.length, 0);
  const selected = enqueue(data, ["large", "LARGE"], "review");
  assert.equal(selected.queue.length, 1);
  assert.equal(enqueue(selected, ["large"], "review").queue.length, 1);
  assert.equal(data.queue.length, 0);
  assert.throws(() => enqueue({ ...data, snapshotAt: "2020-01-01T00:00:00.000Z" }, ["large"], "review"), /seven days/);
});

test("big enqueue rechecks criteria and permits demo planning", () => {
  const data = { ...dataset(), demo: true, snapshotAt: new Date().toISOString() };
  assert.throws(() => enqueue(data, ["large"], "big"), /no longer eligible/);
  data.profiles.large = { username: "large", followerCount: { value: 20_001, exact: true, source: "manual", observedAt: new Date().toISOString() } };
  assert.equal(enqueue(data, ["large"], "big").queue[0]?.status, "pending");
});

test("profile observations preserve newer counts and deduplicate directed evidence", () => {
  const observedAt = new Date(Date.now() - 1000).toISOString();
  const older = new Date(Date.now() - 2000).toISOString();
  const data = applyObservation(dataset(), { username: "large", followerCount: { value: 30_001, exact: true }, observedAt, edges: [{ from: "friend", to: "large", evidence: "Visible following list" }] });
  const again = applyObservation(data, { username: "large", followerCount: { value: 20_001, exact: false }, observedAt: older, edges: [{ from: "friend", to: "large", evidence: "Old evidence" }] });
  assert.equal(again.profiles.large?.followerCount?.value, 30_001);
  assert.equal(again.edges.length, 1);
  assert.equal(again.edges[0]?.evidence, "Visible following list");
  assert.throws(() => applyObservation(data, { username: "large", followerCount: { value: -1, exact: true }, observedAt, edges: [] }), /invalid/);
});
