import { applyObservation, bigCandidates, isFresh, normalizeUsername, relationship, succeededSinceSnapshot } from "./domain.ts";
import { instagramPageTask, observationFromPage } from "./instagram.ts";
import type { InstagramPageResult, InstagramTask } from "./instagram.ts";
import { readState, updateState } from "./storage.ts";
import type { Dataset, ExtensionMessage, ExtensionResponse, QueueItem, StoredState } from "./types.ts";

const ALARM = "igunf-next-account";
const HOST = "https://www.instagram.com/*";

export type QueueApproval = Pick<Extract<ExtensionMessage, { type: "start-queue" }>, "queueIds" | "snapshotAt" | "threshold">;

export function queueItemProblem(dataset: Dataset, item: QueueItem, now: Date): string | undefined {
  if (dataset.demo) return "Demo data cannot operate an Instagram account.";
  if (!isFresh(dataset.snapshotAt, now)) return "The imported snapshot is older than seven days. Import a fresh snapshot before continuing.";
  if (relationship(dataset, item.username) !== "not-following-back") return `@${item.username} is not a confirmed nonreciprocal following in the imported snapshot.`;
  if (item.username === dataset.owner) return "Your own account cannot be queued.";
  if (succeededSinceSnapshot(dataset, item.username) || dataset.queue.some((other) => other.id !== item.id && other.username === item.username && other.status === "running")) return "This account has already been processed since this snapshot or is being processed.";
  if (item.reason === "big" && !bigCandidates(dataset, now).includes(item.username)) return `@${item.username} no longer has a fresh, exact follower count above the threshold.`;
  if (item.reason === "review" && dataset.decisions[item.username]?.kind === "keep") return `@${item.username} is marked Keep. Remove it from the review queue or change that decision.`;
  return undefined;
}

export function startProblem(state: StoredState, owner: string, approval: QueueApproval, now: Date): string | undefined {
  const dataset = state.dataset;
  if (!dataset) return "Import your Instagram data first.";
  if (dataset.owner !== normalizeUsername(owner)) return "The confirmation does not match the imported account.";
  if (state.runner.status === "running" || state.runner.current) return "A queue is already running or checking its final action.";
  if (!approval || approval.snapshotAt !== dataset.snapshotAt || approval.threshold !== dataset.threshold) return "The imported snapshot or threshold changed after the approval dialog opened. Review the queue again.";
  const pending = dataset.queue.filter((item) => item.status === "pending");
  if (!pending.length) return "There are no pending accounts in the queue.";
  if (!Array.isArray(approval.queueIds) || approval.queueIds.some((id) => typeof id !== "string")) return "The approved queue identifiers are missing or invalid. Review the queue again.";
  const approvedIds = new Set(approval.queueIds);
  const pendingIds = new Set(pending.map((item) => item.id));
  if (approvedIds.size !== approval.queueIds.length || pendingIds.size !== pending.length || approvedIds.size !== pendingIds.size || !pending.every((item) => approvedIds.has(item.id))) return "The pending accounts changed after the approval dialog opened. Review the exact queue again.";
  for (const item of pending) { const problem = queueItemProblem(dataset, item, now); if (problem) return problem; }
  return undefined;
}

function activeApprovalProblem(state: StoredState): string | undefined {
  const { dataset, runner } = state;
  const approval = runner.approval;
  if (!dataset || !approval) return "This queue has no persisted approval. Review and approve its pending accounts again.";
  if (dataset.snapshotAt !== approval.snapshotAt || dataset.threshold !== approval.threshold) return "The imported snapshot or threshold changed after approval. The queue has stopped.";
  const approved = new Map(approval.items.map((item) => [item.id, item]));
  for (const item of dataset.queue) {
    if (item.status !== "pending" && item.status !== "running") continue;
    const original = approved.get(item.id);
    if (!original || original.username !== item.username || original.reason !== item.reason) return "A pending account differs from the approved queue. No further action will be sent.";
  }
  return undefined;
}

export function recoverInterrupted(state: StoredState, now: Date): StoredState {
  if (!state.dataset?.queue.some((item) => item.status === "running")) return state;
  const message = "The browser worker stopped during an account action. Its outcome is uncertain; inspect Instagram before explicitly queueing it again.";
  return {
    ...state,
    dataset: { ...state.dataset, queue: state.dataset.queue.map((item) => item.status === "running" ? { ...item, status: "failed", finishedAt: now.toISOString(), message } : item) },
    runner: { ...state.runner, status: "paused", current: undefined, message, updatedAt: now.toISOString() },
  };
}

export interface RunnerPort {
  read(): Promise<StoredState>;
  update(mutator: (state: StoredState) => StoredState): Promise<StoredState>;
  hasPermission(): Promise<boolean>;
  navigate(username: string): Promise<number>;
  execute(tabId: number, task: InstagramTask): Promise<InstagramPageResult>;
  wait(milliseconds: number): Promise<void>;
  scheduled(): Promise<boolean>;
  schedule(milliseconds: number): Promise<void>;
  clear(): Promise<void>;
  now(): Date;
}

export class QueueController {
  private busy = false;
  private readonly port: RunnerPort;
  constructor(port: RunnerPort) { this.port = port; }

  async initialize(): Promise<void> {
    const state = await this.port.update((current) => recoverInterrupted(current, this.port.now()));
    if (state.runner.status === "running" && !(await this.port.scheduled())) await this.port.schedule(30_000);
  }

  async start(owner: string, approval: QueueApproval): Promise<ExtensionResponse> {
    if (this.busy) throw new Error("Wait for the previous account action to finish checking its result.");
    if (!(await this.port.hasPermission())) throw new Error("Enable the optional Instagram site permission before starting.");
    const state = await this.port.update((current) => {
      const problem = startProblem(current, owner, approval, this.port.now());
      if (problem) throw new Error(problem);
      return { ...current, runner: { status: "running", owner: current.dataset!.owner,
        approval: { snapshotAt: approval.snapshotAt, threshold: approval.threshold, items: current.dataset!.queue.filter((item) => item.status === "pending").map(({ id, username, reason }) => ({ id, username, reason })) },
        updatedAt: this.port.now().toISOString(), message: "Approved queue; preparing the first account." } };
    });
    await this.port.schedule(1_000);
    return { ok: true, message: state.runner.message, runner: state.runner };
  }

  async pause(): Promise<ExtensionResponse> {
    const state = await this.port.update((current) => ({ ...current, runner: { ...current.runner, status: "paused", message: "Paused. An already-clicked Instagram action may still finish; its result will be checked.", updatedAt: this.port.now().toISOString() } }));
    await this.port.clear();
    return { ok: true, message: state.runner.message, runner: state.runner };
  }

  private async assertActive(id: string, owner: string, allowPaused = false): Promise<void> {
    const state = await this.port.read();
    if (!state.dataset || state.dataset.owner !== owner || (state.runner.status !== "running" && !(allowPaused && state.runner.status === "paused")) || state.runner.owner !== owner) throw new Error("Queue paused or the imported account changed before the next action.");
    const approvalProblem = activeApprovalProblem(state);
    if (approvalProblem) throw new Error(approvalProblem);
    const item = state.dataset.queue.find((candidate) => candidate.id === id);
    if (item?.status !== "running") throw new Error("The active queue entry changed. No further action will be sent.");
    const problem = queueItemProblem(state.dataset, item, this.port.now());
    if (problem) throw new Error(problem);
    if (!(await this.port.hasPermission())) throw new Error("Instagram site permission was removed. The queue has stopped.");
  }

  async runNext(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    let item: QueueItem | undefined;
    let owner: string | undefined;
    let confirmationSent = false;
    try {
      const state = await this.port.update((current) => {
        if (current.runner.status !== "running" || !current.dataset) return current;
        const approvalProblem = activeApprovalProblem(current);
        if (approvalProblem) throw new Error(approvalProblem);
        const pending = current.dataset.queue.find((candidate) => candidate.status === "pending");
        if (!pending) return { ...current, runner: { ...current.runner, status: "idle", current: undefined, message: "Queue finished. Only accounts with verified results are marked complete.", updatedAt: this.port.now().toISOString() } };
        item = pending;
        owner = current.dataset.owner;
        return {
          ...current,
          dataset: { ...current.dataset, queue: current.dataset.queue.map((candidate) => candidate.id === pending.id ? { ...candidate, status: "running", message: "Preparing profile and verifying the signed-in account." } : candidate) },
          runner: { ...current.runner, current: pending.username, message: `Checking @${pending.username}.`, updatedAt: this.port.now().toISOString() },
        };
      });
      if (!item || !owner || state.runner.status !== "running") return;
      await this.assertActive(item.id, owner);
      const tabId = await this.port.navigate(item.username);
      const modes = ["inspect", "open", "confirm"] as const;
      for (const mode of modes) {
        await this.assertActive(item.id, owner);
        // Mark uncertainty before dispatch: a connection failure cannot prove that a click did not happen.
        if (mode === "confirm") confirmationSent = true;
        const result = await this.port.execute(tabId, { mode, owner, username: item.username });
        if (!result.ok) throw new Error(result.message);
        if (mode !== "inspect") await this.port.wait(mode === "confirm" ? 1_500 : 650);
      }
      // Verify a dispatched action even when the user pauses meanwhile.
      await this.assertActive(item.id, owner, true);
      const verified = await this.port.execute(tabId, { mode: "verify", owner, username: item.username });
      if (!verified.ok || verified.following !== false) throw new Error(verified.message);
      const completed = await this.port.update((current) => {
        if (!current.dataset || current.dataset.owner !== owner) throw new Error("The dataset changed while verifying the result.");
        const approvalProblem = activeApprovalProblem(current);
        if (approvalProblem) throw new Error(approvalProblem);
        const queue = current.dataset.queue.map((candidate) => candidate.id === item!.id ? { ...candidate, status: "succeeded" as const, finishedAt: this.port.now().toISOString(), message: verified.message } : candidate);
        const pending = queue.some((candidate) => candidate.status === "pending");
        return { ...current, dataset: { ...current.dataset, queue }, runner: { ...current.runner, status: current.runner.status === "paused" ? "paused" : pending ? "running" : "idle", current: undefined, message: `Confirmed unfollow of @${item!.username}.${pending ? " Next account is waiting." : " Queue finished."}`, updatedAt: this.port.now().toISOString() } };
      });
      if (completed.runner.status === "running") await this.port.schedule(30_000);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unexpected browser error.";
      const message = confirmationSent ? `${detail} A confirmation may have been sent; inspect Instagram. This item will not be retried automatically.` : detail;
      await this.port.update((current) => ({
        ...current,
        dataset: current.dataset ? { ...current.dataset, queue: current.dataset.queue.map((candidate) => candidate.id === item?.id && candidate.status === "running" ? { ...candidate, status: "failed", finishedAt: this.port.now().toISOString(), message } : candidate) } : null,
        runner: { ...current.runner, status: "paused", current: undefined, message, updatedAt: this.port.now().toISOString() },
      }));
      await this.port.clear();
    } finally { this.busy = false; }
  }
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function execute(tabId: number, task: InstagramTask): Promise<InstagramPageResult> {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func: instagramPageTask, args: [task] });
  const result = results.find((frame) => frame.frameId === 0)?.result;
  if (!result) throw new Error("Instagram did not return a page result. The tab may have closed or navigated.");
  return result;
}

async function navigate(username: string): Promise<number> {
  const session = await chrome.storage.session.get("runnerTabId");
  let tab: chrome.tabs.Tab | undefined;
  if (typeof session.runnerTabId === "number") {
    try { tab = await chrome.tabs.get(session.runnerTabId); } catch { /* A closed tab is replaced before any action. */ }
  }
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  if (tab?.id !== undefined) tab = await chrome.tabs.update(tab.id, { url, active: true });
  else tab = await chrome.tabs.create({ url, active: true });
  if (!tab || tab.id === undefined) throw new Error("Could not create an Instagram queue tab.");
  const tabId = tab.id;
  await chrome.storage.session.set({ runnerTabId: tabId });
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const current = await chrome.tabs.get(tabId);
    if (current.status === "complete" && current.url === url) { await wait(1_000); return tabId; }
    if (current.url && /\/(challenge|checkpoint|accounts\/login)/.test(current.url)) throw new Error("Instagram requires login or an account check. Resolve it manually before continuing.");
    await wait(500);
  }
  throw new Error("The target profile did not finish loading in time. No action was sent.");
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  const controller = new QueueController({
    read: readState, update: updateState,
    hasPermission: () => chrome.permissions.contains({ origins: [HOST] }),
    navigate, execute, wait,
    scheduled: async () => Boolean(await chrome.alarms.get(ALARM)),
    schedule: (milliseconds) => chrome.alarms.create(ALARM, { when: Date.now() + milliseconds }),
    clear: async () => { await chrome.alarms.clear(ALARM); },
    now: () => new Date(),
  });
  const initialized = controller.initialize();
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void initialized.then(() => controller.runNext()); });
  chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse: (response: ExtensionResponse) => void) => {
    if (sender.id !== chrome.runtime.id) return false;
    const handle = async (): Promise<ExtensionResponse> => {
      await initialized;
      switch (message.type) {
        case "get-runner": { const state = await readState(); return { ok: true, message: state.runner.message, runner: state.runner }; }
        case "start-queue": return controller.start(message.owner, message);
        case "pause-queue": return controller.pause();
        case "capture": {
          const before = await readState();
          if (!before.dataset || before.dataset.demo) throw new Error("Import your own Instagram data before capturing profiles.");
          if (before.runner.status === "running" || before.runner.current) throw new Error("Pause the queue and wait for its current result before capturing another profile.");
          const result = await execute(message.tabId, { mode: "capture" });
          const observation = observationFromPage(result, new Date().toISOString());
          await updateState((current) => {
            if (!current.dataset || current.dataset.owner !== before.dataset!.owner || current.dataset.demo || current.runner.status === "running" || current.runner.current) throw new Error("The dataset or queue changed during capture. Try again.");
            return { ...current, dataset: applyObservation(current.dataset, observation) };
          });
          return { ok: true, message: `Captured @${observation.username}: ${observation.followerCount ? `${observation.followerCount.exact ? "exact" : "rounded"} follower count` : "no unambiguous follower count"}, ${observation.edges.length} visible connections.` };
        }
        default: throw new Error("Unsupported extension request.");
      }
    };
    void handle().then(sendResponse, (error: unknown) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "The operation failed." }));
    return true;
  });
}
