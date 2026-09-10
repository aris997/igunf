import assert from "node:assert/strict";
import test from "node:test";
import { QueueController, queueItemProblem, recoverInterrupted, startProblem } from "../src/background.ts";
import type { QueueApproval, RunnerPort } from "../src/background.ts";
import { emptyDataset } from "../src/domain.ts";
import type { InstagramPageResult, InstagramTask } from "../src/instagram.ts";
import type { Dataset, StoredState } from "../src/types.ts";

const NOW = new Date("2026-09-10T12:00:00.000Z");

function dataset(): Dataset {
  return {
    ...emptyDataset("me"), snapshotAt: NOW.toISOString(), followersComplete: true, followingComplete: true,
    following: ["alice", "bob"],
    profiles: { alice: { username: "alice", followerCount: { value: 20_001, exact: true, source: "manual", observedAt: NOW.toISOString() } } },
    queue: ["alice", "bob"].map((username, index) => ({ id: String(index), username, reason: "review", status: "pending", addedAt: NOW.toISOString() })),
  };
}

function harness(data = dataset()) {
  let state: StoredState = { dataset: data, runner: { status: "idle", message: "Ready", updatedAt: NOW.toISOString() } };
  const tasks: InstagramTask["mode"][] = [];
  const navigations: string[] = [];
  const alarms: number[] = [];
  const hooks: { action?: (task: InstagramTask) => Promise<InstagramPageResult | undefined>; wait?: () => Promise<void>; allowed: boolean } = { allowed: true };
  const port: RunnerPort = {
    read: async () => structuredClone(state),
    update: async (mutator) => { state = mutator(structuredClone(state)); return structuredClone(state); },
    hasPermission: async () => hooks.allowed,
    navigate: async (username) => { navigations.push(username); return 5; },
    execute: async (_tabId, task) => {
      tasks.push(task.mode);
      return await hooks.action?.(task) ?? { ok: true, message: "Verified fixture", following: task.mode !== "verify" };
    },
    wait: async () => { await hooks.wait?.(); },
    scheduled: async () => (alarms.at(-1) ?? -1) > 0,
    schedule: async (milliseconds) => { alarms.push(milliseconds); },
    clear: async () => { alarms.push(-1); },
    now: () => NOW,
  };
  const approval = (): QueueApproval => ({ queueIds: state.dataset!.queue.filter((item) => item.status === "pending").map((item) => item.id), snapshotAt: state.dataset!.snapshotAt, threshold: state.dataset!.threshold });
  return { approval, controller: new QueueController(port), port, hooks, tasks, navigations, alarms, state: () => state };
}

test("only fresh, complete nonreciprocal accounts may execute, and demo never executes", () => {
  const data = dataset();
  const item = data.queue[0]!;
  assert.equal(queueItemProblem(data, item, NOW), undefined);
  assert.match(queueItemProblem({ ...data, demo: true }, item, NOW)!, /Demo/);
  assert.match(queueItemProblem({ ...data, followersComplete: false }, item, NOW)!, /confirmed/);
  assert.match(queueItemProblem({ ...data, snapshotAt: "2026-08-01" }, item, NOW)!, /seven days/);
  assert.match(queueItemProblem({ ...data, followers: ["alice"] }, item, NOW)!, /confirmed/);
});

test("big queue has no Keep or friendship exception but needs a fresh exact count above threshold", () => {
  const data = dataset();
  const item = { ...data.queue[0]!, reason: "big" as const };
  data.decisions.alice = { kind: "keep", updatedAt: NOW.toISOString() };
  data.friends = ["alice"];
  assert.equal(queueItemProblem(data, item, NOW), undefined);
  data.profiles.alice!.followerCount!.exact = false;
  assert.match(queueItemProblem(data, item, NOW)!, /fresh, exact/);
  data.profiles.alice!.followerCount!.exact = true;
  data.profiles.alice!.followerCount!.value = 20_000;
  assert.match(queueItemProblem(data, item, NOW)!, /above the threshold/);
});

test("start validates the typed account and optional permission before making any browser calls", async () => {
  const h = harness();
  await assert.rejects(h.controller.start("someone_else", h.approval()), /does not match/);
  h.hooks.allowed = false;
  await assert.rejects(h.controller.start("me", h.approval()), /permission/);
  assert.deepEqual(h.navigations, []);
  assert.deepEqual(h.tasks, []);
  const state = h.state();
  assert.match(startProblem({ ...state, runner: { ...state.runner, status: "paused", current: "alice" } }, "me", h.approval(), NOW)!, /final action/);
});

test("one account per alarm, verified success, and a 30-second next-item schedule", async () => {
  const h = harness();
  await h.controller.start("me", h.approval());
  assert.deepEqual(h.navigations, []);
  await h.controller.runNext();
  assert.deepEqual(h.navigations, ["alice"]);
  assert.deepEqual(h.tasks, ["inspect", "open", "confirm", "verify"]);
  assert.equal(h.state().dataset!.queue[0]!.status, "succeeded");
  assert.equal(h.state().dataset!.queue[1]!.status, "pending");
  assert.equal(h.state().runner.status, "running");
  assert.deepEqual(h.alarms, [1_000, 30_000]);
  await h.controller.runNext();
  assert.equal(h.state().runner.status, "idle");
  assert.equal(h.state().dataset!.queue[1]!.status, "succeeded");
});

test("an uncertain remote result stops the queue and never automatically retries", async () => {
  const h = harness();
  h.hooks.action = async (task) => task.mode === "verify" ? { ok: false, message: "Still following" } : undefined;
  await h.controller.start("me", h.approval());
  await h.controller.runNext();
  assert.equal(h.state().runner.status, "paused");
  assert.equal(h.state().dataset!.queue[0]!.status, "failed");
  assert.match(h.state().dataset!.queue[0]!.message!, /may have been sent/);
  await h.controller.runNext();
  assert.deepEqual(h.navigations, ["alice"]);
});

test("account checks and revoked permission stop before a confirmation click", async () => {
  const h = harness();
  h.hooks.action = async (task) => task.mode === "inspect" ? { ok: false, message: "Wrong signed-in owner" } : undefined;
  await h.controller.start("me", h.approval());
  await h.controller.runNext();
  assert.deepEqual(h.tasks, ["inspect"]);
  assert.equal(h.state().runner.status, "paused");
  const revoked = harness();
  await revoked.controller.start("me", revoked.approval());
  revoked.hooks.allowed = false;
  await revoked.controller.runNext();
  assert.deepEqual(revoked.navigations, []);
  assert.equal(revoked.state().runner.status, "paused");
});

test("pause between opening the menu and confirming sends no unfollow", async () => {
  const h = harness();
  h.hooks.wait = async () => { await h.controller.pause(); };
  await h.controller.start("me", h.approval());
  await h.controller.runNext();
  assert.deepEqual(h.tasks, ["inspect", "open"]);
  assert.equal(h.state().runner.status, "paused");
  assert.equal(h.state().dataset!.queue[0]!.status, "failed");
  assert.equal(h.state().dataset!.queue[1]!.status, "pending");
});

test("pause after dispatch still checks the outcome and prevents the next account", async () => {
  const h = harness();
  h.hooks.action = async (task) => { if (task.mode === "confirm") await h.controller.pause(); return undefined; };
  await h.controller.start("me", h.approval());
  await h.controller.runNext();
  assert.deepEqual(h.tasks, ["inspect", "open", "confirm", "verify"]);
  assert.equal(h.state().runner.status, "paused");
  assert.equal(h.state().dataset!.queue[0]!.status, "succeeded");
  assert.equal(h.state().runner.current, undefined);
  assert.ok(!h.alarms.includes(30_000));
});

test("worker interruption marks the in-flight item uncertain and preserves untouched items", async () => {
  const h = harness();
  await h.controller.start("me", h.approval());
  await h.port.update((state) => ({ ...state, dataset: { ...state.dataset!, queue: state.dataset!.queue.map((item, index) => index === 0 ? { ...item, status: "running" } : item) } }));
  const recovered = recoverInterrupted(h.state(), NOW);
  assert.equal(recovered.runner.status, "paused");
  assert.equal(recovered.dataset!.queue[0]!.status, "failed");
  assert.match(recovered.dataset!.queue[0]!.message!, /uncertain/);
  assert.equal(recovered.dataset!.queue[1]!.status, "pending");
  await new QueueController(h.port).initialize();
  assert.equal(h.state().runner.status, "paused");
  assert.deepEqual(h.tasks, []);
});

test("queue eligibility is checked again after approval and before each action", async () => {
  const h = harness();
  await h.controller.start("me", h.approval());
  await h.port.update((state) => ({ ...state, dataset: { ...state.dataset!, followers: ["alice"] } }));
  await h.controller.runNext();
  assert.equal(h.state().runner.status, "paused");
  assert.deepEqual(h.navigations, []);
});

test("a worker wake preserves the scheduled wait instead of accelerating the queue", async () => {
  const h = harness();
  await h.controller.start("me", h.approval());
  await h.controller.runNext();
  await new QueueController(h.port).initialize();
  assert.deepEqual(h.alarms, [1_000, 30_000]);
  await h.port.clear();
  await new QueueController(h.port).initialize();
  assert.equal(h.alarms.at(-1), 30_000);
});

test("approval rejects stale modal IDs, duplicate IDs, changed snapshot, and changed threshold", async () => {
  for (const edit of [
    (approval: QueueApproval): QueueApproval => ({ ...approval, queueIds: ["0"] }),
    (approval: QueueApproval): QueueApproval => ({ ...approval, queueIds: ["0", "0"] }),
    (approval: QueueApproval): QueueApproval => ({ ...approval, queueIds: ["0", "1", "2"] }),
    (approval: QueueApproval): QueueApproval => ({ ...approval, snapshotAt: "2026-09-09T12:00:00.000Z" }),
    (approval: QueueApproval): QueueApproval => ({ ...approval, threshold: 10_000 }),
  ]) {
    const h = harness();
    await assert.rejects(h.controller.start("me", edit(h.approval())), /changed after|queue identifiers/);
    assert.deepEqual(h.tasks, []);
    assert.deepEqual(h.navigations, []);
    assert.equal(h.state().runner.status, "idle");
  }
});

test("a stale approval modal cannot silently approve an account added from another view", async () => {
  const h = harness();
  const approved = h.approval();
  await h.port.update((state) => ({ ...state, dataset: { ...state.dataset!, following: [...state.dataset!.following, "charlie"], queue: [...state.dataset!.queue, { id: "2", username: "charlie", reason: "review", status: "pending", addedAt: NOW.toISOString() }] } }));
  await assert.rejects(h.controller.start("me", approved), /pending accounts changed/);
  assert.deepEqual(h.navigations, []);
  assert.equal(h.state().dataset!.queue[2]!.status, "pending");
});

test("every remote stage remains bound to the approved snapshot, threshold, and account identity", async () => {
  for (const change of ["snapshot", "threshold", "username", "reason", "extra-item"] as const) {
    const h = harness();
    h.hooks.wait = async () => {
      await h.port.update((state) => {
        const data = state.dataset!;
        if (change === "snapshot") return { ...state, dataset: { ...data, snapshotAt: "2026-09-10T11:59:00.000Z" } };
        if (change === "threshold") return { ...state, dataset: { ...data, threshold: 10_000 } };
        if (change === "extra-item") return { ...state, dataset: { ...data, queue: [...data.queue, { id: "new", username: "charlie", reason: "review", status: "pending", addedAt: NOW.toISOString() }] } };
        return { ...state, dataset: { ...data, queue: data.queue.map((item, index) => index !== 0 ? item : change === "username" ? { ...item, username: "charlie" } : { ...item, reason: "big" }) } };
      });
    };
    await h.controller.start("me", h.approval());
    await h.controller.runNext();
    assert.deepEqual(h.tasks, ["inspect", "open"], change);
    assert.equal(h.state().runner.status, "paused", change);
  }
});

test("persisted approval survives worker replacement and rejects a subsequent snapshot change", async () => {
  const h = harness();
  await h.controller.start("me", h.approval());
  await h.controller.runNext();
  const replacement = new QueueController(h.port);
  await replacement.initialize();
  await h.port.update((state) => ({ ...state, dataset: { ...state.dataset!, snapshotAt: "2026-09-10T11:59:00.000Z" } }));
  await replacement.runNext();
  assert.deepEqual(h.navigations, ["alice"]);
  assert.equal(h.state().runner.status, "paused");
  assert.equal(h.state().dataset!.queue[1]!.status, "pending");
});

test("snapshot replacement after dispatch does not attribute a remote result to the replacement dataset", async () => {
  const h = harness();
  h.hooks.action = async (task) => {
    if (task.mode === "confirm") await h.port.update((state) => ({ ...state, dataset: { ...state.dataset!, snapshotAt: "2026-09-10T11:59:00.000Z" } }));
    return undefined;
  };
  await h.controller.start("me", h.approval());
  await h.controller.runNext();
  assert.deepEqual(h.tasks, ["inspect", "open", "confirm"]);
  assert.equal(h.state().dataset!.queue[0]!.status, "failed");
  assert.match(h.state().runner.message, /may have been sent/);
});

test("a newly captured follow-back prevents the already-approved confirmation", async () => {
  const h = harness();
  h.hooks.wait = async () => {
    await h.port.update((state) => ({ ...state, dataset: { ...state.dataset!, edges: [{ from: "alice", to: "me", source: "profile", observedAt: NOW.toISOString() }] } }));
  };
  await h.controller.start("me", h.approval());
  await h.controller.runNext();
  assert.deepEqual(h.tasks, ["inspect", "open"]);
  assert.equal(h.state().runner.status, "paused");
});

test("historical successes before a newer snapshot do not permanently prevent a newly approved unfollow", () => {
  const data = dataset();
  const pending = data.queue[0]!;
  data.queue.push({ ...pending, id: "historical", status: "succeeded", finishedAt: "2026-09-09T12:00:00.000Z" });
  assert.equal(queueItemProblem(data, pending, NOW), undefined);
  data.queue[data.queue.length - 1]!.finishedAt = NOW.toISOString();
  assert.match(queueItemProblem(data, pending, NOW)!, /processed since this snapshot/);
});
