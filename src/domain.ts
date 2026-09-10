import type { Dataset, ProfileObservation, QueueItem } from "./types.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const RESERVED = new Set(["__proto__", "prototype", "constructor", ".", ".."]);

export function normalizeUsername(input: string): string {
  const value = input.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(value) || RESERVED.has(value)) {
    throw new Error(`Invalid Instagram username: ${input.slice(0, 50)}`);
  }
  return value;
}

export function emptyDataset(owner: string): Dataset {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, owner: normalizeUsername(owner), importedAt: now, snapshotAt: now,
    followersComplete: false, followingComplete: false, followers: [], following: [],
    profiles: Object.create(null) as Dataset["profiles"], edges: [], friends: [],
    decisions: Object.create(null) as Dataset["decisions"], queue: [], threshold: 20_000, demo: false,
  };
}

export function relationship(dataset: Dataset, username: string): "mutual" | "not-following-back" | "unknown" | "follower-only" {
  const name = normalizeUsername(username);
  const follows = dataset.following.includes(name);
  const followedBy = dataset.followers.includes(name) || dataset.edges.some((edge) => edge.from === name && isCurrentFollowerEvidence(dataset, edge));
  if (follows && followedBy) return "mutual";
  if (follows && dataset.followingComplete && dataset.followersComplete) return "not-following-back";
  if (followedBy && dataset.followingComplete) return "follower-only";
  return "unknown";
}

function isCurrentFollowerEvidence(dataset: Dataset, edge: Dataset["edges"][number]): boolean {
  return edge.source !== "export" && edge.to === dataset.owner && Date.parse(edge.observedAt) >= Date.parse(dataset.snapshotAt);
}

function knownFollowers(dataset: Dataset): Set<string> {
  return new Set([...dataset.followers, ...dataset.edges.filter((edge) => isCurrentFollowerEvidence(dataset, edge)).map((edge) => edge.from)]);
}

export function isFresh(iso: string, now = new Date()): boolean {
  const age = now.getTime() - Date.parse(iso);
  return Number.isFinite(age) && age >= 0 && age <= WEEK_MS;
}

export function sharedFriends(dataset: Dataset, username: string): string[] {
  const name = normalizeUsername(username);
  const friends = new Set(dataset.friends);
  return [...new Set(dataset.edges.filter((edge) => edge.to === name && edge.from !== name && friends.has(edge.from)).map((edge) => edge.from))].sort();
}

function successfulActionsSinceSnapshot(dataset: Dataset): QueueItem[] {
  const snapshotTime = Date.parse(dataset.snapshotAt);
  return dataset.queue.filter((item) => item.status === "succeeded" && Date.parse(item.finishedAt ?? item.addedAt) >= snapshotTime);
}

export function succeededSinceSnapshot(dataset: Dataset, username: string): boolean {
  const name = normalizeUsername(username);
  return successfulActionsSinceSnapshot(dataset).some((item) => item.username === name);
}

export function bigCandidates(dataset: Dataset, now = new Date()): string[] {
  if (!isFresh(dataset.snapshotAt, now)) return [];
  const succeeded = new Set(successfulActionsSinceSnapshot(dataset).map((item) => item.username));
  const followers = knownFollowers(dataset);
  if (!dataset.followersComplete || !dataset.followingComplete) return [];
  return dataset.following.filter((name) => {
    const count = dataset.profiles[name]?.followerCount;
    return !followers.has(name) && !succeeded.has(name) && count?.exact === true
      && Number.isSafeInteger(count.value) && count.value > dataset.threshold && isFresh(count.observedAt, now);
  });
}

export function enqueue(dataset: Dataset, usernames: string[], reason: "review" | "big"): Dataset {
  if (!isFresh(dataset.snapshotAt)) throw new Error("Import a snapshot from the last seven days before queueing unfollows.");
  const unavailable = new Set([
    ...dataset.queue.filter((item) => item.status === "pending" || item.status === "running"),
    ...successfulActionsSinceSnapshot(dataset),
  ].map((item) => item.username));
  const names = [...new Set(usernames.map(normalizeUsername))].filter((name) => !unavailable.has(name));
  const eligibleBig = reason === "big" ? new Set(bigCandidates(dataset)) : null;
  const followers = knownFollowers(dataset);
  const following = new Set(dataset.following);
  for (const name of names) {
    if (!dataset.followersComplete || !dataset.followingComplete || !following.has(name) || followers.has(name) || (eligibleBig && !eligibleBig.has(name))) {
      throw new Error(`@${name} is no longer eligible for this queue.`);
    }
  }
  const now = new Date().toISOString();
  const queue: QueueItem[] = names.map((username) => ({
    id: crypto.randomUUID(), username, reason, status: "pending", addedAt: now,
  }));
  return { ...dataset, queue: [...dataset.queue, ...queue] };
}

export function applyObservation(dataset: Dataset, observation: ProfileObservation): Dataset {
  const username = normalizeUsername(observation.username);
  const observedMs = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedMs) || observedMs > Date.now() + 60_000) throw new Error("The profile observation has an invalid date.");
  if (observation.edges.length > 5_000) throw new Error("Too many profile connections in a single observation.");
  const count = observation.followerCount;
  if (count && (!Number.isSafeInteger(count.value) || count.value < 0 || typeof count.exact !== "boolean")) {
    throw new Error("The profile follower count is invalid.");
  }
  const profiles = { ...dataset.profiles };
  const existing = profiles[username] ?? { username };
  const replaceCount = count && (!existing.followerCount || Date.parse(existing.followerCount.observedAt) <= observedMs);
  profiles[username] = {
    ...existing, username,
    ...(observation.displayName ? { displayName: observation.displayName.slice(0, 200) } : {}),
    ...(replaceCount ? { followerCount: { ...count, source: "profile" as const, observedAt: observation.observedAt } } : {}),
  };
  const edges = new Map(dataset.edges.map((edge) => [`${edge.from}\0${edge.to}\0${edge.source}`, edge]));
  for (const edge of observation.edges) {
    const from = normalizeUsername(edge.from);
    const to = normalizeUsername(edge.to);
    if (from === to) continue;
    profiles[from] ??= { username: from };
    profiles[to] ??= { username: to };
    const key = `${from}\0${to}\0profile`;
    const prior = edges.get(key);
    if (!prior || Date.parse(prior.observedAt) <= observedMs) {
      edges.set(key, { from, to, source: "profile", observedAt: observation.observedAt, evidence: edge.evidence.slice(0, 500) });
    }
  }
  return { ...dataset, profiles, edges: [...edges.values()] };
}
