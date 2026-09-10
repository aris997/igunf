import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildGraphModel, renderGraph } from "../src/graph.ts";
import type { Dataset } from "../src/types.ts";

function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    schemaVersion: 1,
    owner: "me",
    importedAt: "2026-09-10T10:00:00Z",
    snapshotAt: "2026-09-10T10:00:00Z",
    followersComplete: true,
    followingComplete: true,
    followers: ["friend"],
    following: ["friend", "creator"],
    profiles: {},
    edges: [],
    friends: ["friend"],
    decisions: {},
    queue: [],
    threshold: 20_000,
    demo: false,
    ...overrides,
  };
}

test("graph uses imported relationships without inferring friend-to-account edges", () => {
  const graph = buildGraphModel(dataset());
  assert.deepEqual(graph.edges.map(({ from, to }) => [from, to]), [
    ["me", "friend"], ["me", "creator"], ["friend", "me"],
  ]);
  assert.equal(graph.nodes.find((node) => node.username === "creator")?.kind, "nonreciprocal");
  assert.equal(graph.nodes.find((node) => node.username === "friend")?.kind, "friend");
});

test("either incomplete relationship list prevents nonreciprocal classification", () => {
  for (const incomplete of [{ followersComplete: false }, { followingComplete: false }, { followersComplete: false, followingComplete: false }]) {
    const graph = buildGraphModel(dataset(incomplete));
    assert.equal(graph.nodes.find((node) => node.username === "creator")?.kind, "other");
    assert.equal(graph.nodes.find((node) => node.username === "friend")?.kind, "friend");
  }
});

test("newer observed follow-back evidence prevents a nonreciprocal graph label", () => {
  const graph = buildGraphModel(dataset({ edges: [{ from: "creator", to: "me", source: "profile", observedAt: "2026-09-10T11:00:00Z" }] }));
  assert.equal(graph.nodes.find((node) => node.username === "creator")?.kind, "other");
  assert.ok(graph.edges.some((edge) => edge.from === "creator" && edge.to === "me"));
});

test("focused graph exposes observed direct relationships and their provenance only", () => {
  const evidence = { from: "friend", to: "creator", source: "manual" as const, observedAt: "2026-09-10T11:00:00Z", evidence: "Visible following list" };
  const graph = buildGraphModel(dataset({ followers: ["friend", "unrelated"], edges: [evidence] }), "creator");
  assert.deepEqual(graph.nodes.map((node) => node.username), ["creator", "me", "friend"]);
  assert.equal(graph.edges.find((edge) => edge.from === "friend" && edge.to === "creator"), evidence);
  assert.ok(!graph.edges.some((edge) => edge.from === "creator" && edge.to === "friend"));
  assert.ok(!graph.nodes.some((node) => node.username === "unrelated"));
});

test("overview caps large graphs, prioritizes friends, and drops edges to omitted nodes", () => {
  const accounts = Array.from({ length: 120 }, (_, index) => `person_${String(index).padStart(3, "0")}`);
  const graph = buildGraphModel(dataset({ following: accounts, followers: [], friends: ["person_119"] }));
  assert.equal(graph.nodes.length, 70);
  assert.equal(graph.omittedNodes, 51);
  assert.equal(graph.nodes[0]?.username, "me");
  assert.equal(graph.nodes[1]?.username, "person_119");
  const visible = new Set(graph.nodes.map((node) => node.username));
  assert.ok(graph.edges.every((edge) => visible.has(edge.from) && visible.has(edge.to)));
});

test("graph renders untrusted data as text and supports keyboard selection and cleanup", () => {
  const dom = new JSDOM("<!doctype html><div id='graph'></div>");
  const original = { document: globalThis.document, Element: globalThis.Element, AbortController: globalThis.AbortController };
  Object.assign(globalThis, { document: dom.window.document, Element: dom.window.Element, AbortController: dom.window.AbortController });
  try {
    const container = dom.window.document.querySelector<HTMLElement>("#graph");
    assert.ok(container);
    const calls: string[] = [];
    const malicious = "<img src=x onerror=alert(1)>";
    const cleanup = renderGraph(container, dataset({ following: [malicious], profiles: { [malicious]: { username: malicious, displayName: "<script>bad()</script>" } } }), malicious, (username) => calls.push(username));
    assert.equal(container.querySelectorAll("img,script").length, 0);
    assert.ok(container.textContent?.includes(malicious));
    assert.ok(container.textContent?.includes("A missing line is unknown"));
    const node = [...container.querySelectorAll<SVGGElement>("[data-node]")].find((candidate) => candidate.getAttribute("data-node") === malicious);
    assert.ok(node);
    node.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.deepEqual(calls, [malicious]);
    assert.match(container.querySelector(".connection-graph__edge")?.getAttribute("aria-label") ?? "", /Source: export\. Observed/);
    cleanup();
    assert.equal(container.children.length, 0);
    node.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(calls.length, 1);
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});
