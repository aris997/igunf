import { Unzip, UnzipInflate } from "fflate";
import { emptyDataset, normalizeUsername } from "./domain.ts";
import type { Dataset, Decision, Edge, Profile, QueueItem } from "./types.ts";

const MIB = 1024 * 1024;
const MAX_JSON_BYTES = 20 * MIB;
const MAX_INPUT_BYTES = 40 * MIB;
const MAX_EXPANDED_BYTES = 80 * MIB;
const MAX_ACCOUNTS = 300_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
interface ImportFile { name: string; data: Uint8Array }
interface ImportOptions { owner: string; snapshotAt: string; followersComplete: boolean; followingComplete: boolean }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key) || forbiddenKeys.has(key)) throw new Error(`Unexpected ${label} field: ${key}`);
  }
}

function string(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== "string" || value.length > maximum) throw new Error(`${label} must be text of at most ${maximum} characters.`);
  return value;
}

function username(value: unknown): string {
  return normalizeUsername(string(value, "Username", 50));
}

function date(value: unknown, label: string): string {
  const text = string(value, label, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error(`${label} must be a valid ISO date and time.`);
  }
  return new Date(text).toISOString();
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
  return value;
}

function integer(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${label} must be a nonnegative integer.`);
  return value;
}

function array(value: unknown, label: string, maximum = MAX_ACCOUNTS): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be a list with at most ${maximum} entries.`);
  return value as unknown[];
}

function names(value: unknown, label: string): string[] {
  const result = array(value, label).map(username);
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate usernames.`);
  return result;
}

function parseJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown) => {
    if (forbiddenKeys.has(key)) throw new Error(`Unsafe JSON field: ${key}`);
    return value;
  }) as unknown;
}

function basename(path: string): string {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("The archive contains an unsafe file path.");
  }
  return path.split("/").at(-1) ?? "";
}

function recognized(name: string): boolean {
  const base = basename(name);
  if (/^followers_.*\.json$/.test(base) && !/^followers_[1-9]\d*\.json$/.test(base)) throw new Error("Invalid follower shard filename. Use the original Instagram filenames.");
  return /^(?:followers(?:_[1-9]\d*)?|following)\.json$/.test(base);
}

function unzipFiles(data: Uint8Array): ImportFile[] {
  if (data.byteLength < 22) throw new Error("The ZIP archive is truncated.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.byteLength - 22;
  const firstPossibleEnd = Math.max(0, data.byteLength - 65_557);
  while (end >= firstPossibleEnd && (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== data.byteLength)) end--;
  if (end < firstPossibleEnd) throw new Error("The ZIP archive is incomplete or unsupported.");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== count || count === 65_535 || count > 20_000 || directoryOffset + directorySize !== end) {
    throw new Error("Multi-part, ZIP64, or oversized ZIP archives are unsupported. Select the JSON files directly.");
  }
  let offset = directoryOffset;
  let declaredSize = 0;
  const expected = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid ZIP directory.");
    const nameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > end) throw new Error("Invalid ZIP entry length.");
    const name = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    if (recognized(name)) {
      const size = view.getUint32(offset + 24, true);
      if (view.getUint16(offset + 8, true) & 1) throw new Error("Encrypted ZIP files are unsupported.");
      declaredSize += size;
      if (size > MAX_JSON_BYTES || declaredSize > MAX_EXPANDED_BYTES || expected.size >= 100) throw new Error("The ZIP exceeds the import size limits.");
      if (expected.has(name)) throw new Error("The ZIP contains duplicate relationship files.");
      expected.add(name);
    }
    offset = next;
  }
  if (offset !== end) throw new Error("Invalid ZIP directory size.");
  const result: ImportFile[] = [];
  let expanded = 0;
  const active = new Set<string>();
  const discovered = new Set<string>();
  const unzip = new Unzip((file) => {
    if (!recognized(file.name)) return;
    if (!expected.has(file.name) || discovered.has(file.name)) throw new Error("The ZIP file headers do not match its directory.");
    discovered.add(file.name);
    active.add(file.name);
    let size = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length;
      expanded += chunk.length;
      if (size > MAX_JSON_BYTES || expanded > MAX_EXPANDED_BYTES) {
        file.terminate();
        throw new Error("The ZIP exceeds the expanded data limit.");
      }
      chunks.push(chunk);
      if (final) {
        const joined = new Uint8Array(size);
        let position = 0;
        for (const part of chunks) { joined.set(part, position); position += part.length; }
        result.push({ name: file.name, data: joined });
        active.delete(file.name);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small compressed chunks bound memory before we can inspect actual expanded sizes.
  for (let start = 0; start < data.length; start += 1024) unzip.push(data.subarray(start, start + 1024), start + 1024 >= data.length);
  if (active.size || result.length !== expected.size) throw new Error("The ZIP relationship files are incomplete.");
  return result;
}

function listEntries(data: Uint8Array, kind: "followers" | "following", label: string): string[] {
  if (data.byteLength > MAX_JSON_BYTES) throw new Error(`${label} exceeds the 20 MiB JSON limit.`);
  const parsed = parseJson(decoder.decode(data));
  const raw = kind === "followers" && Array.isArray(parsed) ? parsed : object(parsed, label)[`relationships_${kind}`];
  return array(raw, label).map((value, index) => {
    const entry = object(value, `${label} entry ${index + 1}`);
    const details = array(entry.string_list_data, "string_list_data", 1);
    if (details.length !== 1) throw new Error(`${label} contains an entry without a username.`);
    const detail = object(details[0], "Relationship entry");
    if (detail.value !== undefined && typeof detail.value !== "string") throw new Error(`${label} contains a malformed username value.`);
    const name = username(typeof detail.value === "string" && detail.value ? detail.value : entry.title);
    if (entry.title !== undefined && entry.title !== "" && username(entry.title) !== name) throw new Error(`${label} has conflicting account names.`);
    if (detail.timestamp !== undefined) integer(detail.timestamp, "Relationship timestamp");
    if (detail.href !== undefined) {
      const href = new URL(string(detail.href, "Profile URL", 500));
      const parts = href.pathname.split("/").filter(Boolean);
      const linkedName = parts[0] === "_u" ? parts[1] : parts[0];
      if (href.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(href.hostname) || href.username || href.password || href.port || !linkedName || username(linkedName) !== name || parts.length > (parts[0] === "_u" ? 2 : 1)) {
        throw new Error(`${label} contains a mismatched Instagram profile URL.`);
      }
    }
    return name;
  });
}

export async function importFiles(files: ImportFile[], options: ImportOptions, previous?: Dataset | null): Promise<Dataset> {
  const owner = normalizeUsername(options.owner);
  const snapshotAt = date(options.snapshotAt, "Snapshot date");
  if (Date.parse(snapshotAt) > Date.now() + 60_000) throw new Error("The snapshot date cannot be in the future.");
  const followersComplete = boolean(options.followersComplete, "Followers completeness");
  const followingComplete = boolean(options.followingComplete, "Following completeness");
  if (!files.length || files.length > 100) throw new Error("Select up to 100 Instagram JSON files or a ZIP archive.");
  if (files.reduce((sum, file) => sum + file.data.byteLength, 0) > MAX_INPUT_BYTES) throw new Error("Selected files exceed the 40 MiB input limit. Select only the relationship JSON files.");
  const expanded = files.flatMap((file) => file.name.toLowerCase().endsWith(".zip") ? unzipFiles(file.data) : [file]);
  if (expanded.reduce((sum, file) => sum + file.data.byteLength, 0) > MAX_EXPANDED_BYTES) throw new Error("Expanded files exceed the import limit.");
  const followerFiles = new Map<number, ImportFile>();
  let unnumbered = false;
  let followingFile: ImportFile | undefined;
  for (const file of expanded) {
    const name = basename(file.name);
    if (name === "following.json") {
      if (followingFile) throw new Error("Multiple following.json files were selected; use one export snapshot.");
      followingFile = file;
      continue;
    }
    const match = /^followers(?:_([1-9]\d*))?\.json$/.exec(name);
    if (!match) {
      if (/^followers_.*\.json$/.test(name)) throw new Error("Invalid follower shard filename. Use the original Instagram filenames.");
      continue;
    }
    const shard = match[1] === undefined ? 1 : Number(match[1]);
    if (!Number.isSafeInteger(shard) || shard > 100 || followerFiles.has(shard)) throw new Error("Duplicate or invalid follower shards. Select all shards from one export.");
    unnumbered ||= match[1] === undefined;
    followerFiles.set(shard, file);
  }
  if (!followingFile && !followerFiles.size) throw new Error("No followers_1.json or following.json found. Request an Instagram export in JSON format.");
  if (followersComplete && !followerFiles.size) throw new Error("Followers cannot be marked complete without a followers file.");
  if (followingComplete && !followingFile) throw new Error("Following cannot be marked complete without following.json.");
  if (unnumbered && followerFiles.size > 1) throw new Error("Do not mix followers.json with numbered follower shards.");
  for (let shard = 1; shard <= followerFiles.size; shard++) {
    if (!followerFiles.has(shard)) throw new Error(`Missing followers_${shard}.json. Select every follower shard.`);
  }
  const followers = [...followerFiles.entries()].sort(([a], [b]) => a - b).flatMap(([, file]) => listEntries(file.data, "followers", file.name));
  const following = followingFile ? listEntries(followingFile.data, "following", followingFile.name) : [];
  if (followers.length > MAX_ACCOUNTS || following.length > MAX_ACCOUNTS) throw new Error("The export exceeds the account limit.");
  if (new Set(followers).size !== followers.length || new Set(following).size !== following.length) throw new Error("Duplicate accounts found. Select lists from a single export snapshot.");
  if (followers.includes(owner) || following.includes(owner)) throw new Error("The export contains the owner in their own relationship lists. Check the account username.");
  const preserved = previous?.owner === owner ? previous : null;
  const dataset = emptyDataset(owner);
  dataset.snapshotAt = snapshotAt;
  dataset.followersComplete = followersComplete;
  dataset.followingComplete = followingComplete;
  dataset.followers = followers;
  dataset.following = following;
  dataset.profiles = { ...(preserved?.profiles ?? {}) };
  for (const name of [owner, ...followers, ...following]) dataset.profiles[name] ??= { username: name };
  const followerNames = new Set(followers);
  const followingNames = new Set(following);
  const preservedEdges = preserved?.edges.filter((edge) => {
    if (edge.source === "export") return false;
    if (Date.parse(edge.observedAt) > Date.parse(snapshotAt)) return true;
    if (edge.to === owner && followersComplete && !followerNames.has(edge.from)) return false;
    if (edge.from === owner && followingComplete && !followingNames.has(edge.to)) return false;
    return true;
  }) ?? [];
  dataset.edges = [
    ...preservedEdges,
    ...followers.map((from): Edge => ({ from, to: owner, source: "export", observedAt: snapshotAt })),
    ...following.map((to): Edge => ({ from: owner, to, source: "export", observedAt: snapshotAt })),
  ];
  dataset.friends = [...(preserved?.friends ?? [])];
  dataset.decisions = { ...(preserved?.decisions ?? {}) };
  dataset.threshold = preserved?.threshold ?? 20_000;
  dataset.queue = preserved?.queue.filter((item) => ["succeeded", "failed", "skipped"].includes(item.status)) ?? [];
  return dataset;
}

export function parseBackup(text: string): Dataset {
  if (new TextEncoder().encode(text).byteLength > MAX_EXPANDED_BYTES) throw new Error("Backup exceeds the 80 MiB limit.");
  const raw = object(parseJson(text), "Backup");
  keys(raw, ["schemaVersion", "owner", "importedAt", "snapshotAt", "followersComplete", "followingComplete", "followers", "following", "profiles", "edges", "friends", "decisions", "queue", "threshold", "demo"], "backup");
  if (raw.schemaVersion !== 1) throw new Error("Unsupported backup schema version.");
  const result = emptyDataset(username(raw.owner));
  result.importedAt = date(raw.importedAt, "Import date");
  result.snapshotAt = date(raw.snapshotAt, "Snapshot date");
  result.followersComplete = boolean(raw.followersComplete, "Followers completeness");
  result.followingComplete = boolean(raw.followingComplete, "Following completeness");
  result.followers = names(raw.followers, "Followers");
  result.following = names(raw.following, "Following");
  result.friends = names(raw.friends, "Friends");
  if ([...result.followers, ...result.following, ...result.friends].includes(result.owner)) throw new Error("The owner cannot appear in their own relationship lists.");
  result.threshold = integer(raw.threshold, "Follower threshold", 1_000_000_000_000);
  result.demo = boolean(raw.demo, "Demo flag");
  const profiles = object(raw.profiles, "Profiles");
  if (Object.keys(profiles).length > MAX_ACCOUNTS * 2 + 1) throw new Error("Too many profiles.");
  for (const [key, value] of Object.entries(profiles)) {
    const name = username(key);
    const profile = object(value, "Profile");
    keys(profile, ["username", "displayName", "followerCount"], "profile");
    if (key !== name || username(profile.username) !== name) throw new Error("Profile key does not match its username.");
    const parsed: Profile = { username: name };
    if (profile.displayName !== undefined) parsed.displayName = string(profile.displayName, "Display name", 200);
    if (profile.followerCount !== undefined) {
      const count = object(profile.followerCount, "Follower count");
      keys(count, ["value", "exact", "observedAt", "source"], "follower count");
      if (count.source !== "manual" && count.source !== "profile") throw new Error("Invalid count source.");
      parsed.followerCount = { value: integer(count.value, "Follower count"), exact: boolean(count.exact, "Exact count"), observedAt: date(count.observedAt, "Count date"), source: count.source };
    }
    result.profiles[name] = parsed;
  }
  const followers = new Set(result.followers);
  const following = new Set(result.following);
  result.edges = array(raw.edges, "Edges", MAX_ACCOUNTS * 4).map((value): Edge => {
    const edge = object(value, "Edge");
    keys(edge, ["from", "to", "source", "observedAt", "evidence"], "edge");
    if (edge.source !== "manual" && edge.source !== "profile" && edge.source !== "export") throw new Error("Invalid edge source.");
    const from = username(edge.from);
    const to = username(edge.to);
    if (from === to) throw new Error("Self edges are invalid.");
    if (edge.source === "export" && !((to === result.owner && followers.has(from)) || (from === result.owner && following.has(to)))) throw new Error("Export edge contradicts the snapshot lists.");
    return { from, to, source: edge.source, observedAt: date(edge.observedAt, "Edge date"), ...(edge.evidence === undefined ? {} : { evidence: string(edge.evidence, "Edge evidence") }) };
  });
  const decisions = object(raw.decisions, "Decisions");
  if (Object.keys(decisions).length > MAX_ACCOUNTS) throw new Error("Too many decisions.");
  for (const [key, value] of Object.entries(decisions)) {
    const decision = object(value, "Decision");
    keys(decision, ["kind", "updatedAt"], "decision");
    if (!["keep", "unfollow", "later"].includes(String(decision.kind))) throw new Error("Invalid review decision.");
    const name = username(key);
    if (name !== key) throw new Error("Decision username must be canonical.");
    result.decisions[name] = { kind: decision.kind as Decision["kind"], updatedAt: date(decision.updatedAt, "Decision date") };
  }
  const ids = new Set<string>();
  result.queue = array(raw.queue, "Queue").map((value): QueueItem => {
    const item = object(value, "Queue item");
    keys(item, ["id", "username", "reason", "status", "addedAt", "finishedAt", "message"], "queue item");
    const id = string(item.id, "Queue ID", 100);
    if (!id || ids.has(id)) throw new Error("Queue IDs must be unique and nonempty.");
    ids.add(id);
    if (item.reason !== "review" && item.reason !== "big") throw new Error("Invalid queue reason.");
    if (!["pending", "running", "succeeded", "failed", "skipped"].includes(String(item.status))) throw new Error("Invalid queue status.");
    return { id, username: username(item.username), reason: item.reason, status: item.status as QueueItem["status"], addedAt: date(item.addedAt, "Queue date"), ...(item.finishedAt === undefined ? {} : { finishedAt: date(item.finishedAt, "Queue finish date") }), ...(item.message === undefined ? {} : { message: string(item.message, "Queue message", 1_000) }) };
  }).filter((item) => ["succeeded", "failed", "skipped"].includes(item.status));
  return result;
}
