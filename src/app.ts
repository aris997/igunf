import type { Dataset, ExtensionResponse, StoredState } from "./types.ts";
import { bigCandidates, enqueue, isFresh, normalizeUsername, relationship, sharedFriends, succeededSinceSnapshot } from "./domain.ts";
import { importFiles, parseBackup } from "./importer.ts";
import { readState, updateState } from "./storage.ts";
import { renderGraph } from "./graph.ts";
import { demoDataset } from "./demo.ts";

type Tab = "review" | "graph" | "big" | "queue" | "data";
const root = document.querySelector<HTMLElement>("#app")!;
const modal = document.querySelector<HTMLDialogElement>("#modal")!;
const toastElement = document.querySelector<HTMLElement>("#toast")!;
const inExtension = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
let stored: StoredState;
let demo: Dataset | null = new URLSearchParams(location.search).has("demo") ? demoDataset() : null;
let tab: Tab = "review";
let selected: string | undefined;
let search = "";
let filter = "nonfollowers";
let sort = "connections";
let visibleLimit = 100;
let graphCleanup: (() => void) | undefined;
let toastTimer: ReturnType<typeof setTimeout>;
let lastState = "";
let busy = false;

function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function data(): Dataset | null { return demo ?? stored?.dataset ?? null; }
function running(): boolean { return stored?.runner.status === "running" || Boolean(stored?.runner.current); }
function count(value: number): string { return new Intl.NumberFormat("en").format(value); }
function compact(value: number): string { return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function when(value: string): string { return new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); }
function avatar(username: string, large = false): string {
  const palette = ["sage", "lavender", "peach", "sand", "blue"];
  const index = [...username].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length;
  const name = data()?.profiles[username]?.displayName ?? username;
  const initials = name.split(/[ ._]+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
  return `<span class="avatar ${palette[index]} ${large ? "large" : ""}">${escape(initials)}</span>`;
}
function icon(name: string): string {
  const paths: Record<string, string> = {
    review: '<path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01"/>',
    graph: '<circle cx="5" cy="5" r="3"/><circle cx="19" cy="9" r="3"/><circle cx="9" cy="19" r="3"/><path d="m8 6 8 2M6 8l2 8m4 1 5-6"/>',
    big: '<path d="M4 20V10m8 10V4m8 16v-7"/><path d="M2 20h20"/>',
    queue: '<path d="M3 6h12M3 12h8M3 18h8m6-7 5 4-5 4z"/>',
    data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 6v1"/>',
    arrow: '<path d="M5 19 19 5M5 5h14v14"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.review}</svg>`;
}

function toast(message: string, error = false): void {
  clearTimeout(toastTimer);
  toastElement.textContent = message;
  toastElement.classList.toggle("error", error);
  toastElement.hidden = false;
  toastTimer = setTimeout(() => { toastElement.hidden = true; }, error ? 9000 : 4500);
}

async function mutate(fn: (dataset: Dataset) => Dataset): Promise<void> {
  if (busy || running()) throw new Error("Pause the running batch before changing its data.");
  if (demo) demo = fn(demo);
  else {
    stored = await updateState((state) => {
      if (state.runner.status === "running" || state.runner.current) throw new Error("Pause the batch and wait for its current action to finish.");
      if (!state.dataset) throw new Error("Import your account first.");
      return { ...state, dataset: fn(state.dataset) };
    });
    lastState = JSON.stringify(stored);
  }
  render();
}

function button(action: string, label: string, className = "", attrs = ""): string {
  return `<button class="button ${className}" data-action="${action}" ${attrs}>${label}</button>`;
}

function render(): void {
  graphCleanup?.();
  graphCleanup = undefined;
  const dataset = data();
  const nonfollowers = dataset?.following.filter((name) => relationship(dataset, name) === "not-following-back") ?? [];
  const pending = dataset?.queue.filter((item) => item.status === "pending").length ?? 0;
  const nav: Array<[Tab, string, number | undefined]> = [
    ["review", "Review following", nonfollowers.length], ["graph", "Your connections", undefined],
    ["big", "Big accounts", dataset ? bigCandidates(dataset).length : 0], ["queue", "Cleanup queue", pending], ["data", "Your data", undefined],
  ];
  root.innerHTML = `
    <header class="topbar"><a class="brand" href="app.html" aria-label="IgUnf home"><span class="brand-mark">i</span>IgUnf<span class="brand-sub">a little closer</span></a>
      <div class="top-actions"><span class="privacy-pill">${icon("lock")} Stored on this device</span>${button("expand", `Full view ${icon("arrow")}`, "quiet expand")}</div>
    </header>
    ${demo ? `<div class="demo-banner"><span><strong>Demo workspace</strong> · Illustrative people and connections. Live actions are disabled.</span>${button("exit-demo", "Use my data →", "text-button")}</div>` : !inExtension ? '<div class="demo-banner">Browser preview · Analysis works locally. Load the Chrome extension to capture profiles or run a batch.</div>' : ""}
    <div class="workspace"><aside class="sidebar">
      <div class="account-switch"><span class="self-avatar">${dataset ? escape(dataset.owner.slice(0, 1).toUpperCase()) : "＋"}</span><div><strong>${dataset ? `@${escape(dataset.owner)}` : "Your Instagram"}</strong><span>${dataset ? `Snapshot · ${when(dataset.snapshotAt)}` : "Connect through a local export"}</span></div></div>
      <div class="nav-label">YOUR WORKSPACE</div><nav aria-label="Workspace">${nav.map(([id, label, total]) => `<button class="nav-item ${tab === id ? "active" : ""}" data-action="tab" data-tab="${id}" aria-current="${tab === id ? "page" : "false"}">${icon(id)}<span>${label}</span>${total === undefined ? "" : `<span class="nav-count">${count(total)}</span>`}</button>`).join("")}</nav>
      <div class="sidebar-note"><span class="little-star">✳</span><strong>Less noise.<br>More people.</strong><p>A following list that feels a little more like you.</p></div>
      <div class="local-note"><span class="status-dot"></span> Local workspace<span>v0.1 · No cloud sync</span></div>
    </aside><main class="main">
      ${running() ? `<div class="notice runner-notice"><span><strong>Batch running${stored.runner.current ? ` · @${escape(stored.runner.current)}` : ""}</strong><br>${escape(stored.runner.message)}</span>${button("pause", "Pause batch", "danger")}</div>` : stored?.runner.status === "paused" ? `<div class="notice"><span><strong>Batch paused</strong> · ${escape(stored.runner.message)}</span></div>` : ""}
      ${dataset && (!dataset.followersComplete || !dataset.followingComplete || !isFresh(dataset.snapshotAt)) ? `<div class="notice"><span>${!dataset.followersComplete || !dataset.followingComplete ? "Incomplete snapshot. Missing relationships stay unknown and cannot enter the queue." : "This snapshot is over 7 days old. Import a fresh export before adding or running unfollows."}</span>${button("tab", "Update data", "text-button", 'data-tab="data"')}</div>` : ""}
      ${!dataset && tab !== "data" ? emptyView() : tab === "data" ? dataView() : dataset ? workspaceView(dataset, nonfollowers.length) : ""}
    </main></div>`;
  if (tab === "graph" && dataset) {
    const container = document.querySelector<HTMLElement>("#network");
    if (container) graphCleanup = renderGraph(container, dataset, selected, (username) => { selected = username; render(); });
  }
  wireForms();
}

function emptyView(): string {
  return `<section class="welcome"><div class="eyebrow">YOUR CIRCLE, ON YOUR TERMS</div><h1>Make room for<br>your people<span>.</span></h1><p class="intro">See who follows you back, explore the connections that matter, and decide who stays in your circle.</p>
    <div class="welcome-actions">${button("tab", "Import Instagram data →", "primary", 'data-tab="data"')}${button("demo", "Explore a demo", "")}</div>
    <div class="welcome-art" aria-hidden="true"><span class="art-line a"></span><span class="art-line b"></span><span class="art-line c"></span><span class="art-person one">S</span><span class="art-person two">M</span><span class="art-person three">A</span><span class="art-person four">L</span><span class="art-self">you</span><div class="art-caption">Familiar faces. Real connections.</div></div>
    <div class="welcome-bottom"><div>${icon("lock")}<strong>Only on your device</strong><p>Your export, graph, and decisions stay in this browser.</p></div><div>${icon("graph")}<strong>See the connections</strong><p>Explore observed relationships with friends you identify.</p></div><div>${icon("review")}<strong>You have the final say</strong><p>Review people individually. Approve every batch before it runs.</p></div></div></section>`;
}

function workspaceView(dataset: Dataset, nonfollowers: number): string {
  const headings: Record<Exclude<Tab, "data">, [string, string, string]> = {
    review: ["A MORE INTENTIONAL FOLLOWING", "Make room for your people.", "A little context for every connection. You decide who stays."],
    graph: ["FOLLOW THE CONNECTIONS", "See your circle.", "Explore the people between you and someone you follow."],
    big: ["TURN DOWN THE VOLUME", "Less noise. More friends.", "One place for big accounts that don’t follow you back."],
    queue: ["YOUR DECISIONS, READY TO REVIEW", "A little breathing room.", "Queued is a plan. Only confirmed actions count as unfollowed."],
  };
  const [eyebrow, title, subtitle] = headings[tab as Exclude<Tab, "data">];
  const stats = `<div class="stats"><div class="stat"><span>Following</span><strong>${count(dataset.following.length)}</strong><small>in your imported snapshot</small></div><div class="stat"><span>Don’t follow back</span><strong>${count(nonfollowers)}<i class="orange-dot"></i></strong><small>${dataset.followersComplete && dataset.followingComplete ? "with complete imported lists" : "complete lists needed to confirm"}</small></div><div class="stat"><span>Your people</span><strong>${count(dataset.friends.length)}<i class="green-dot"></i></strong><small>friends you’ve identified</small></div></div>`;
  return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div>${tab === "review" ? button("tab", `${icon("graph")} Explore graph`, "", 'data-tab="graph"') : ""}</div>
    ${tab === "review" ? stats : ""}
    ${tab === "queue" ? queueView(dataset) : tab === "graph" ? `<div class="graph-toolbar"><div><strong>${selected ? `Around @${escape(selected)}` : "Your known network"}</strong><span class="muted small"> Select a person to explore their connections</span></div>${button("overview", "Show everyone", "quiet")}</div><div class="graph-layout"><div id="network"></div>${detailsView(dataset)}</div><div class="graph-disclaimer">Lines show observed follows, not proof of friendship. Unseen relationships are unknown. Your decisions can provide labels for a future model; this view does not use a neural network.</div>` : listView(dataset)} `;
}

function visibleAccounts(dataset: Dataset): string[] {
  let names = tab === "big" ? bigCandidates(dataset) : dataset.following;
  if (tab !== "big") names = names.filter((name) => filter === "all" || (filter === "nonfollowers" && relationship(dataset, name) === "not-following-back") || (filter === "mutual" && relationship(dataset, name) === "mutual") || (filter === "decided" && Boolean(dataset.decisions[name])));
  const term = search.trim().toLowerCase();
  names = names.filter((name) => `${name} ${dataset.profiles[name]?.displayName ?? ""}`.toLowerCase().includes(term));
  return [...names].sort((a, b) => sort === "followers" ? (dataset.profiles[b]?.followerCount?.value ?? -1) - (dataset.profiles[a]?.followerCount?.value ?? -1) : sort === "name" ? a.localeCompare(b) : sharedFriends(dataset, b).length - sharedFriends(dataset, a).length || a.localeCompare(b));
}

function listView(dataset: Dataset): string {
  const names = visibleAccounts(dataset);
  const candidates = bigCandidates(dataset);
  const unknownCounts = dataset.following.filter((name) => relationship(dataset, name) === "not-following-back" && (!dataset.profiles[name]?.followerCount || !dataset.profiles[name]!.followerCount!.exact || !isFresh(dataset.profiles[name]!.followerCount!.observedAt))).length;
  return `${tab === "big" ? `<section class="rule-card"><div><span class="eyebrow">YOUR CLEANUP RULE</span><p>More than <strong>${count(dataset.threshold)}</strong> followers <span class="muted">＋</span> doesn’t follow you back</p><span class="muted small">Includes friends and accounts marked Keep. ${count(unknownCounts)} account${unknownCounts === 1 ? " needs" : "s need"} a fresh, exact follower count.</span></div>${button("queue-big", `Queue all ${count(candidates.length)} ${icon("arrow")}`, "primary", candidates.length && !running() ? "" : "disabled")}</section>` : ""}
    <div class="content-grid"><section class="list-panel"><div class="list-toolbar"><label class="search-field">${icon("search")}<input id="search" aria-label="Search accounts" placeholder="Find someone in your circle…" value="${escape(search)}"></label><select id="sort" aria-label="Sort accounts"><option value="connections" ${sort === "connections" ? "selected" : ""}>Most connections</option><option value="followers" ${sort === "followers" ? "selected" : ""}>Most followers</option><option value="name" ${sort === "name" ? "selected" : ""}>Username A–Z</option></select></div>
    ${tab === "review" ? `<div class="filters" aria-label="Account filters">${[["nonfollowers", "Don’t follow back"], ["all", "Everyone"], ["mutual", "Mutual"], ["decided", "Reviewed"]].map(([value, label]) => `<button class="filter ${filter === value ? "selected" : ""}" data-action="filter" data-filter="${value}" aria-pressed="${filter === value}">${label}</button>`).join("")}</div>` : ""}
    <div class="list-caption"><span>${count(names.length)} ACCOUNTS</span><span>FOLLOWERS / CONNECTIONS</span></div>
    <div class="account-list">${names.length ? names.slice(0, visibleLimit).map((name) => accountRow(dataset, name)).join("") : `<div class="empty-list"><span>✳</span><h3>${search ? "No matching people" : tab === "big" ? "No confirmed matches yet" : "All clear here"}</h3><p>${tab === "big" ? "Capture profile counts or add exact counts while reviewing. Missing and rounded counts are excluded." : "Try another filter, or import complete lists to see who doesn’t follow back."}</p></div>`}</div>
    ${names.length > visibleLimit ? button("more", `Show more (${count(names.length - visibleLimit)} remaining)`, "load-more") : ""}
    <div class="list-footer"><span class="status-dot"></span> Decisions stay local until you approve a batch.</div></section>${detailsView(dataset)}</div>`;
}

function accountRow(dataset: Dataset, username: string): string {
  const profile = dataset.profiles[username];
  const friends = sharedFriends(dataset, username);
  const decision = dataset.decisions[username];
  const queued = dataset.queue.find((item) => item.username === username && (["pending", "running"].includes(item.status) || (item.status === "succeeded" && succeededSinceSnapshot(dataset, username))));
  return `<button class="account-row ${selected === username ? "selected" : ""}" data-action="select" data-username="${escape(username)}" aria-label="Review ${escape(username)}">${avatar(username)}<span class="account-name"><strong>${escape(profile?.displayName ?? username)} ${dataset.friends.includes(username) ? '<span class="friend-star" title="Marked as your friend">✳</span>' : ""}</strong><span>@${escape(username)}</span><span class="row-decision">${queued ? queued.status === "succeeded" ? "Unfollow confirmed" : "In cleanup queue" : decision ? decision.kind === "keep" ? "Keeping" : decision.kind === "later" ? "Review later" : "Unfollow decision" : relationship(dataset, username) === "mutual" ? "Follows you back" : ""}</span></span><span class="row-metrics"><strong>${profile?.followerCount ? `${profile.followerCount.exact ? "" : "≈"}${compact(profile.followerCount.value)}` : "—"}</strong><span>${friends.length ? `<i class="connection-dot"></i>${friends.length} friend${friends.length === 1 ? "" : "s"}` : "No known connections"}</span></span><span class="row-arrow">↗</span></button>`;
}

function detailsView(dataset: Dataset): string {
  if (!selected || !dataset.profiles[selected]) return `<aside class="detail-panel empty-detail"><div class="detail-orbit">✳</div><div class="eyebrow">EVERY CONNECTION HAS A STORY</div><h2>Get a little<br>more context.</h2><p>Select someone to see your shared connections and decide what feels right.</p><div class="tiny-legend"><span><i class="green-dot"></i>Your friends</span><span><i class="orange-dot"></i>Not following back</span></div></aside>`;
  const username = selected;
  const profile = dataset.profiles[username]!;
  const friends = sharedFriends(dataset, username);
  const relation = relationship(dataset, username);
  const queued = dataset.queue.some((item) => item.username === username && ["pending", "running"].includes(item.status)) || succeededSinceSnapshot(dataset, username);
  const disabled = running() ? "disabled" : "";
  return `<aside class="detail-panel"><div class="detail-top">${avatar(username, true)}${button("deselect", "×", "icon-button", 'aria-label="Close account details"')}</div><h2>${escape(profile.displayName ?? username)}</h2><a class="profile-link" ${demo ? 'href="#" data-action="demo-link"' : `href="https://www.instagram.com/${encodeURIComponent(username)}/" target="_blank" rel="noopener noreferrer"`}>@${escape(username)} ↗</a>
    <div class="relation-tag ${relation === "mutual" ? "mutual" : ""}">${relation === "mutual" ? "↔ Follows you back" : relation === "not-following-back" ? "↗ Doesn’t follow back" : "? Relationship unknown"}</div>
    <div class="detail-count"><strong>${profile.followerCount ? `${profile.followerCount.exact ? "" : "≈ "}${count(profile.followerCount.value)}` : "Unknown"}</strong><span>followers</span>${profile.followerCount ? `<small>${profile.followerCount.exact ? "Exact" : "Rounded"} · ${escape(profile.followerCount.source)} · ${when(profile.followerCount.observedAt)}</small>` : ""}</div>
    <div class="detail-section"><div class="eyebrow">CONNECTED THROUGH YOUR PEOPLE</div>${friends.length ? `<div class="friend-stack">${friends.slice(0, 5).map((friend) => avatar(friend)).join("")}</div><p>${friends.map((friend) => `<button class="inline-link" data-action="select" data-username="${escape(friend)}">${escape(dataset.profiles[friend]?.displayName ?? friend)}</button>`).join(", ")} follow this account in your recorded evidence.</p>` : '<p>No connections to your marked friends have been recorded. This doesn’t mean none exist.</p>'}${button("show-graph", `See connections ${icon("graph")}`, "wide quiet")}</div>
    <label class="check-row friend-check"><input type="checkbox" id="friend-toggle" ${dataset.friends.includes(username) ? "checked" : ""} ${username === dataset.owner ? "disabled" : disabled}> I know this person as a friend</label>
    <div class="decision-buttons">${button("keep", dataset.decisions[username]?.kind === "keep" ? "✓ Keeping" : "Keep", "keep", disabled)}${button("later", "Later", "", disabled)}</div>${button("queue-one", queued ? "Already queued / completed" : "Queue unfollow", "wide", relation !== "not-following-back" || queued || running() || !isFresh(dataset.snapshotAt) ? "disabled" : "")}
    <details class="evidence-editor"><summary>Add evidence</summary><form id="count-form"><label>Exact follower count<input name="count" type="number" min="0" max="10000000000" step="1" placeholder="e.g. 24831" required ${disabled}></label><p class="small muted">Enter the full count you observed today. A displayed “20K” is rounded and cannot establish more than 20,000.</p><button class="button quiet wide" ${disabled}>Save count</button></form><form id="edge-form"><label>Who follows @${escape(username)}?<input name="from" placeholder="Friend’s username" required ${disabled}></label><button class="button quiet wide" ${disabled}>Record this follow</button></form><p class="small muted">Only record relationships you actually observed. Mark the other person as a friend to show them above.</p></details>
  </aside>`;
}

function queueView(dataset: Dataset): string {
  const pending = dataset.queue.filter((item) => item.status === "pending");
  const succeeded = dataset.queue.filter((item) => item.status === "succeeded").length;
  return `<div class="queue-summary"><div><strong>${count(pending.length)}</strong><span>ready to review</span></div><div><strong>${count(succeeded)}</strong><span>confirmed unfollows</span></div>${button("start", demo ? "Demo · live actions disabled" : "Preview & start batch →", "primary", !pending.length || demo || !inExtension || running() ? "disabled" : "")}</div>
    <div class="notice subtle">The experimental runner uses Instagram’s visible controls, one account at a time. It stops on uncertainty or restrictions. A delay does not guarantee protection from account restrictions.</div>
    <section class="list-panel queue-list">${dataset.queue.length ? [...dataset.queue].reverse().map((item) => `<div class="queue-row">${avatar(item.username)}<div class="queue-person"><strong>@${escape(item.username)}</strong><span>${item.reason === "big" ? `Big-account rule` : "Your individual decision"}${item.message ? ` · ${escape(item.message)}` : ""}</span></div><span class="queue-status ${item.status}">${escape(item.status)}</span>${item.status === "pending" && !running() ? button("remove-queue", "×", "icon-button", `data-id="${escape(item.id)}" aria-label="Remove ${escape(item.username)} from queue"`) : ""}</div>`).join("") : '<div class="empty-list"><span>✓</span><h3>Your queue has room.</h3><p>Review someone, or use the big-account rule to prepare your cleanup.</p></div>'}</section>
    <p class="small muted">Interrupted actions are never retried automatically. Check the profile manually before deciding what to do next. Reimport a fresh export to reconcile your following list.</p>`;
}

function dataView(): string {
  const dataset = data();
  const disabled = running() || busy ? "disabled" : "";
  return `<div class="page-heading"><div><div class="eyebrow">PRIVATE BY DESIGN</div><h1>Your data. Your device.</h1><p>Bring in a snapshot. Build a clearer picture of your circle.</p></div>${!dataset ? button("demo", "Try a demo ↗") : ""}</div>
    <div class="data-grid"><section class="form-card"><span class="step-label">01 / IMPORT YOUR CONNECTIONS</span><h2>Start with your Instagram export.</h2><p>In Instagram settings, open Accounts Center / Meta Account → your information → export or download your information. Choose <strong>followers and following</strong>, <strong>all time</strong>, and <strong>JSON</strong>. Import the ZIP or all matching JSON files.</p>
    <form id="import-form"><label>Your Instagram username<input name="owner" autocomplete="off" placeholder="your.username" value="${dataset && !demo ? escape(dataset.owner) : ""}" required ${disabled}></label><label>When was the export generated?<input name="snapshot" type="datetime-local" required ${disabled}></label><label class="file-drop"><span>＋</span><strong>Choose ZIP or JSON files</strong><small>All follower shards + following.json · up to 40 MiB total</small><input name="files" type="file" accept=".zip,.json" multiple required ${disabled}></label><label class="check-row"><input name="followersComplete" type="checkbox" ${disabled}><span>I included <strong>every follower file</strong> from an all-time export.</span></label><label class="check-row"><input name="followingComplete" type="checkbox" ${disabled}><span>I included the <strong>complete following list</strong> from the same export.</span></label><p class="small muted">Unchecked means incomplete. Missing names will stay unknown. Verify the export belongs to the username above; connection files alone may not identify their owner.</p><button class="button primary wide" ${disabled}>${busy ? "Importing…" : "Import locally →"}</button><p class="small muted">A new import replaces the snapshot and clears pending actions. Same-account decisions and recorded evidence are kept.</p></form></section>
    <div class="data-side"><section class="form-card"><span class="step-label">02 / FILL IN THE CONTEXT</span><h2>Connections grow as you review.</h2><p>Your export establishes connections to you. To add other evidence, visit a profile on Instagram and choose <strong>Save this profile’s evidence</strong> from the IgUnf toolbar popup.</p><p>Supported visible profile counts and open connection lists are saved with a timestamp. You can also record an exact count or a known follow in an account’s <strong>Add evidence</strong> section.</p><div class="notice subtle">Capture does not crawl accounts or make a partial list complete.</div></section>
    <section class="form-card"><span class="step-label">03 / MAKE IT YOURS</span><h2>Your cleanup threshold.</h2><form id="threshold-form"><label>More than this many followers<input name="threshold" type="number" value="${dataset?.threshold ?? 20000}" min="0" max="10000000000" step="1" required ${disabled}></label><button class="button wide" ${!dataset || running() ? "disabled" : ""}>Save threshold</button></form><p class="small muted">Only exact counts and complete snapshots observed within 7 days qualify. A count equal to the threshold does not qualify. Changes clear pending big-account actions.</p></section>
    <section class="form-card backup-card"><h2>Take it with you.</h2><p>Back up the local graph, observations, decisions, and action history. Backups contain personal relationship data.</p>${button("backup", "Export local backup ↓", "wide", dataset ? "" : "disabled")}<label class="button wide restore-button">Restore a backup<input type="file" id="restore-file" accept=".json" ${disabled}></label>${button("clear", "Delete local workspace", "text-button danger-text", !stored?.dataset || running() || demo ? "disabled" : "")}</section></div></div>`;
}

function showModal(content: string): void {
  modal.innerHTML = content;
  modal.showModal();
}

function askConfirmation(title: string, text: string, actionLabel: string, action: () => Promise<void>): void {
  showModal(`<div class="modal-heading"><h2 id="modal-title">${escape(title)}</h2>${button("close-modal", "×", "icon-button", 'aria-label="Close dialog"')}</div><p>${escape(text)}</p><div class="modal-actions">${button("close-modal", "Cancel")}${button("confirm-modal", escape(actionLabel), "primary")}</div>`);
  modal.querySelector('[data-action="confirm-modal"]')!.addEventListener("click", () => {
    modal.close();
    void action().catch(handleError);
  }, { once: true });
}

function startDialog(dataset: Dataset): void {
  if (demo || dataset.demo || !inExtension) throw new Error("Live actions are disabled in demo and browser preview.");
  const pending = dataset.queue.filter((item) => item.status === "pending");
  if (!pending.length) return;
  showModal(`<div class="modal-heading"><h2 id="modal-title">Approve ${pending.length} unfollows</h2>${button("close-modal", "×", "icon-button", 'aria-label="Close dialog"')}</div><p>Signed-in account must be <strong>@${escape(dataset.owner)}</strong>. The runner will open Instagram, verify the account and each target, then act sequentially.</p><div class="batch-preview">${pending.map((item) => `<div><strong>@${escape(item.username)}</strong><span>${item.reason === "big" ? "Big-account rule" : "Individual decision"}</span></div>`).join("")}</div><form id="start-form"><label>Type your username to approve<input name="owner" autocomplete="off" placeholder="${escape(dataset.owner)}" required></label><label class="check-row"><input name="acknowledge" type="checkbox" required><span>I approve this list and understand that browser automation can trigger Instagram restrictions.</span></label><p class="small muted">Chrome will request access to instagram.com. A private account may require approval if you decide to follow it again.</p><div id="start-error" class="form-error" role="alert"></div><div class="modal-actions">${button("close-modal", "Cancel")}<button class="button primary" type="submit">Approve & start</button></div></form>`);
  modal.querySelector<HTMLFormElement>("#start-form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const errorElement = modal.querySelector<HTMLElement>("#start-error")!;
    if (String(form.get("owner")).trim().replace(/^@/, "").toLowerCase() !== dataset.owner) {
      errorElement.textContent = "The username must match this workspace’s account.";
      return;
    }
    const submit = modal.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.disabled = true;
    // Request in the click gesture so Chrome can show its permission prompt.
    void chrome.permissions.request({ origins: ["https://www.instagram.com/*"] }).then(async (granted) => {
      if (!granted) throw new Error("Instagram access was not granted. The queue has not started.");
      const response: ExtensionResponse = await chrome.runtime.sendMessage({ type: "start-queue", owner: dataset.owner, queueIds: pending.map((item) => item.id), snapshotAt: dataset.snapshotAt, threshold: dataset.threshold });
      if (!response.ok) throw new Error(response.message);
      modal.close();
      toast(response.message);
      await refresh();
    }).catch((error: unknown) => { errorElement.textContent = error instanceof Error ? error.message : String(error); submit.disabled = false; });
  });
}

async function refresh(): Promise<void> {
  const state = await readState();
  const encoded = JSON.stringify(state);
  if (encoded === lastState) return;
  stored = state;
  lastState = encoded;
  if (!modal.open && !busy && !(document.activeElement instanceof HTMLInputElement)) render();
}

function wireForms(): void {
  document.querySelector<HTMLInputElement>("#search")?.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    const cursor = input.selectionStart;
    search = input.value;
    visibleLimit = 100;
    render();
    const next = document.querySelector<HTMLInputElement>("#search")!;
    next.focus(); next.setSelectionRange(cursor, cursor);
  });
  document.querySelector<HTMLSelectElement>("#sort")?.addEventListener("change", (event) => { sort = (event.target as HTMLSelectElement).value; render(); });
  document.querySelector<HTMLInputElement>("#friend-toggle")?.addEventListener("change", (event) => {
    const checked = (event.target as HTMLInputElement).checked;
    const username = selected!;
    if (username === data()?.owner) return;
    void mutate((dataset) => ({ ...dataset, friends: checked ? [...new Set([...dataset.friends, username])] : dataset.friends.filter((name) => name !== username) })).catch(handleError);
  });
  document.querySelector<HTMLFormElement>("#count-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = Number(new FormData(event.currentTarget as HTMLFormElement).get("count"));
    const username = selected!;
    if (!Number.isSafeInteger(value) || value < 0 || value > 1e10) return toast("Enter a valid exact follower count.", true);
    void mutate((dataset) => ({ ...dataset, profiles: { ...dataset.profiles, [username]: { ...dataset.profiles[username]!, followerCount: { value, exact: true, observedAt: new Date().toISOString(), source: "manual" } } } })).then(() => toast("Exact follower count saved.")).catch(handleError);
  });
  document.querySelector<HTMLFormElement>("#edge-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const from = normalizeUsername(String(new FormData(event.currentTarget as HTMLFormElement).get("from")));
      const to = selected!;
      if (from === to) throw new Error("An account cannot follow itself.");
      void mutate((dataset) => ({ ...dataset, profiles: { ...dataset.profiles, [from]: dataset.profiles[from] ?? { username: from } }, edges: [...dataset.edges.filter((edge) => !(edge.from === from && edge.to === to && edge.source === "manual")), { from, to, source: "manual", observedAt: new Date().toISOString(), evidence: "Follow recorded by workspace owner" }] })).then(() => toast("Observed follow saved. Mark that person as a friend to include them as friend evidence.")).catch(handleError);
    } catch (error) { handleError(error); }
  });
  document.querySelector<HTMLFormElement>("#threshold-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const threshold = Number(new FormData(event.currentTarget as HTMLFormElement).get("threshold"));
    if (!Number.isSafeInteger(threshold) || threshold < 0 || threshold > 1e10) return toast("Enter a valid threshold.", true);
    void mutate((dataset) => ({ ...dataset, threshold, queue: dataset.queue.filter((item) => item.reason !== "big" || item.status !== "pending") })).then(() => toast("Threshold saved; pending big-account actions cleared for a fresh selection.")).catch(handleError);
  });
  document.querySelector<HTMLFormElement>("#import-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
    if (!files.length) return toast("Choose the export ZIP or JSON files.", true);
    if (files.reduce((total, file) => total + file.size, 0) > 40 * 1024 * 1024) return toast("Choose a followers-and-following export smaller than 40 MiB.", true);
    if (running()) return toast("Pause the batch before importing.", true);
    const perform = async (): Promise<void> => {
      busy = true;
      const previous = stored.dataset;
      const previousVersion = JSON.stringify(previous);
      render();
      try {
        const result = await importFiles(await Promise.all(files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))), {
          owner: String(form.get("owner")), snapshotAt: new Date(String(form.get("snapshot"))).toISOString(),
          followersComplete: form.has("followersComplete"), followingComplete: form.has("followingComplete"),
        }, previous);
        stored = await updateState((state) => {
          if (state.runner.status === "running" || state.runner.current) throw new Error("A batch started during import. Pause it and wait for the current action to finish, then try again.");
          if (JSON.stringify(state.dataset) !== previousVersion) throw new Error("Your workspace changed during import. Nothing was overwritten. Try the import again with the latest data.");
          return { ...state, dataset: result, runner: { status: "idle", message: "New snapshot imported.", updatedAt: new Date().toISOString() } };
        });
        demo = null; selected = undefined; tab = "review"; search = ""; filter = "nonfollowers";
        history.replaceState(null, "", "app.html");
        toast(`Imported ${count(result.following.length)} following and ${count(result.followers.length)} follower${result.followers.length === 1 ? "" : "s"}.`);
      } finally { busy = false; render(); }
    };
    if (stored.dataset) askConfirmation("Replace this snapshot?", "This replaces the current imported lists and clears pending actions. Same-account decisions and evidence are preserved. Export a backup first if you want the current snapshot.", "Replace & import", perform);
    else void perform().catch(handleError);
  });
  document.querySelector<HTMLInputElement>("#restore-file")?.addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 80 * 1024 * 1024) return toast("Backup is too large (maximum 80 MiB).", true);
    void file.text().then((text) => {
      const restored = parseBackup(text);
      askConfirmation(`Restore @${restored.owner}?`, "This replaces the local workspace. Pending actions in the backup are discarded. Nothing will run automatically.", "Restore backup", async () => {
        stored = await updateState((state) => {
          if (state.runner.status === "running" || state.runner.current) throw new Error("Pause the batch and wait for its current action before restoring.");
          return { dataset: restored, runner: { status: "idle", message: "Backup restored.", updatedAt: new Date().toISOString() } };
        });
        demo = null; selected = undefined; render(); toast("Backup restored. Live actions have not started.");
      });
    }).catch(handleError);
  });
}

function handleError(error: unknown): void { toast(error instanceof Error ? error.message : String(error), true); }

async function onAction(action: string, element: HTMLElement): Promise<void> {
  const dataset = data();
  if (action === "tab") { tab = element.dataset.tab as Tab; search = ""; visibleLimit = 100; render(); }
  else if (action === "demo") { demo = demoDataset(); selected = undefined; tab = "review"; history.replaceState(null, "", "app.html?demo=1"); render(); }
  else if (action === "exit-demo") { demo = null; selected = undefined; tab = stored.dataset ? "review" : "data"; history.replaceState(null, "", "app.html"); render(); }
  else if (action === "expand") { if (inExtension) await chrome.tabs.create({ url: chrome.runtime.getURL(`app.html${demo ? "?demo=1" : ""}`) }); else window.open(`app.html${demo ? "?demo=1" : ""}`, "_blank", "noopener"); }
  else if (action === "filter") { filter = element.dataset.filter!; render(); }
  else if (action === "select") { selected = element.dataset.username!; render(); }
  else if (action === "deselect" || action === "overview") { selected = undefined; render(); }
  else if (action === "more") { visibleLimit += 100; render(); }
  else if (action === "show-graph") { tab = "graph"; render(); }
  else if (action === "demo-link") toast("These are illustrative demo accounts.");
  else if (action === "close-modal") { modal.close(); render(); }
  else if (action === "pause") {
    if (!inExtension) return;
    const response: ExtensionResponse = await chrome.runtime.sendMessage({ type: "pause-queue" });
    toast(response.message, !response.ok); await refresh();
  }
  else if (dataset) {
    if (action === "keep" || action === "later") {
      const username = selected!;
      await mutate((current) => ({ ...current, decisions: { ...current.decisions, [username]: { kind: action, updatedAt: new Date().toISOString() } }, queue: current.queue.filter((item) => !(item.username === username && item.reason === "review" && item.status === "pending")) }));
      toast(action === "keep" ? "Marked Keep. The big-account rule still applies if this account qualifies." : "Saved for later.");
    } else if (action === "queue-one") {
      const username = selected!;
      await mutate((current) => enqueue({ ...current, decisions: { ...current.decisions, [username]: { kind: "unfollow", updatedAt: new Date().toISOString() } } }, [username], "review"));
      toast("Added to your queue. Review the batch before anything happens on Instagram.");
    } else if (action === "queue-big") {
      await mutate((current) => enqueue(current, bigCandidates(current), "big"));
      tab = "queue"; render(); toast("Qualifying accounts added. Review and approve the batch when ready.");
    } else if (action === "remove-queue") await mutate((current) => ({ ...current, queue: current.queue.filter((item) => item.id !== element.dataset.id || item.status !== "pending") }));
    else if (action === "start") startDialog(dataset);
    else if (action === "backup") {
      const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `igunf-${dataset.owner}-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (action === "clear") askConfirmation("Delete your local workspace?", "This deletes the imported snapshot, graph, decisions, and action history from this extension. Your Instagram account is unchanged. Export a backup first if you want to keep a copy.", "Delete local data", async () => {
      stored = await updateState((state) => {
        if (state.runner.status === "running" || state.runner.current) throw new Error("Pause the batch and wait for its current action before deleting data.");
        return { dataset: null, runner: { status: "idle", message: "Local workspace deleted.", updatedAt: new Date().toISOString() } };
      });
      selected = undefined; render(); toast("Local workspace deleted.");
    });
  }
}

document.addEventListener("click", (event) => {
  const element = (event.target as Element).closest<HTMLElement>("[data-action]");
  if (!element || (element instanceof HTMLButtonElement && element.disabled)) return;
  event.preventDefault();
  void onAction(element.dataset.action!, element).catch(handleError);
});

void readState().then((state) => {
  stored = state;
  lastState = JSON.stringify(state);
  render();
  setInterval(() => { void refresh().catch(handleError); }, 2000);
}).catch((error: unknown) => {
  root.innerHTML = '<div class="fatal"><h1>Local storage is unavailable.</h1><p>Enable browser storage for this extension and reopen it.</p></div>';
  handleError(error);
});
