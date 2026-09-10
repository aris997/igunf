export type EvidenceSource = "export" | "manual" | "profile";

export interface FollowerCount {
  value: number;
  exact: boolean;
  observedAt: string;
  source: "manual" | "profile";
}

export interface Profile {
  username: string;
  displayName?: string;
  followerCount?: FollowerCount;
}

export interface Edge {
  from: string;
  to: string;
  observedAt: string;
  source: EvidenceSource;
  evidence?: string;
}

export interface Decision {
  kind: "keep" | "unfollow" | "later";
  updatedAt: string;
}

export interface QueueItem {
  id: string;
  username: string;
  reason: "review" | "big";
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  addedAt: string;
  finishedAt?: string;
  message?: string;
}

export interface Dataset {
  schemaVersion: 1;
  owner: string;
  importedAt: string;
  snapshotAt: string;
  followersComplete: boolean;
  followingComplete: boolean;
  followers: string[];
  following: string[];
  profiles: Record<string, Profile>;
  edges: Edge[];
  friends: string[];
  decisions: Record<string, Decision>;
  queue: QueueItem[];
  threshold: number;
  demo: boolean;
}

export interface RunnerState {
  status: "idle" | "running" | "paused";
  owner?: string;
  current?: string;
  approval?: {
    snapshotAt: string;
    threshold: number;
    items: Array<Pick<QueueItem, "id" | "username" | "reason">>;
  };
  message: string;
  updatedAt: string;
}

export interface StoredState {
  dataset: Dataset | null;
  runner: RunnerState;
}

export interface ProfileObservation {
  username: string;
  displayName?: string;
  followerCount?: { value: number; exact: boolean };
  edges: Array<{ from: string; to: string; evidence: string }>;
  observedAt: string;
}

export type ExtensionMessage =
  | { type: "capture"; tabId: number }
  | { type: "start-queue"; owner: string; queueIds: string[]; snapshotAt: string; threshold: number }
  | { type: "pause-queue" }
  | { type: "get-runner" };

export interface ExtensionResponse {
  ok: boolean;
  message: string;
  runner?: RunnerState;
}
