import type { Dataset, Edge } from "./types.ts";

type NodeKind = "owner" | "friend" | "nonreciprocal" | "other";

interface GraphNode {
  username: string;
  kind: NodeKind;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: Edge[];
  omittedNodes: number;
  focused: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_NODES = 70;
const WIDTH = 880;
const HEIGHT = 580;
let graphId = 0;

/** Imported lists are evidence of owner relationships, even without extra observed edges. */
export function buildGraphModel(dataset: Dataset, selected?: string): GraphModel {
  const friends = new Set(dataset.friends);
  const following = new Set(dataset.following);
  const followers = new Set(dataset.followers);
  for (const edge of dataset.edges) {
    if (edge.source !== "export" && edge.to === dataset.owner && Date.parse(edge.observedAt) >= Date.parse(dataset.snapshotAt)) followers.add(edge.from);
  }
  const nodeKind = (username: string): NodeKind => {
    if (username === dataset.owner) return "owner";
    if (friends.has(username)) return "friend";
    if (dataset.followersComplete && dataset.followingComplete && following.has(username) && !followers.has(username)) return "nonreciprocal";
    return "other";
  };
  const edgeMap = new Map<string, Edge>();
  const addEdge = (edge: Edge): void => {
    if (edge.from !== edge.to) edgeMap.set(`${edge.from}\u0000${edge.to}`, edge);
  };
  for (const username of dataset.following) {
    addEdge({ from: dataset.owner, to: username, source: "export", observedAt: dataset.snapshotAt });
  }
  for (const username of dataset.followers) {
    addEdge({ from: username, to: dataset.owner, source: "export", observedAt: dataset.snapshotAt });
  }
  for (const edge of dataset.edges) addEdge(edge);
  const knownEdges = [...edgeMap.values()];
  const accounts = new Set([
    dataset.owner,
    ...dataset.following,
    ...dataset.followers,
    ...dataset.friends,
    ...Object.keys(dataset.profiles),
    ...knownEdges.flatMap((edge) => [edge.from, edge.to]),
  ]);
  const focused = Boolean(selected && selected !== dataset.owner);
  let candidates = accounts;
  if (focused && selected) {
    candidates = new Set([dataset.owner, selected]);
    for (const edge of knownEdges) {
      if (edge.from === selected) candidates.add(edge.to);
      if (edge.to === selected) candidates.add(edge.from);
    }
  }
  const priority = (username: string): number => {
    if (username === selected) return -2;
    if (username === dataset.owner) return -1;
    const kind = nodeKind(username);
    return kind === "friend" ? 0 : kind === "nonreciprocal" ? 1 : 2;
  };
  const usernames = [...candidates].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  const nodes = usernames.slice(0, MAX_NODES).map((username) => ({ username, kind: nodeKind(username) }));
  const visible = new Set(nodes.map((node) => node.username));
  return {
    nodes,
    edges: knownEdges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)),
    omittedNodes: Math.max(0, usernames.length - MAX_NODES),
    focused,
  };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const result = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) result.setAttribute(name, String(value));
  return result;
}

function observedDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "unknown date" : date.toLocaleString();
}

function edgeDescription(edge: Edge): string {
  return `@${edge.from} follows @${edge.to}. Source: ${edge.source}. Observed ${observedDate(edge.observedAt)}.${edge.evidence ? ` ${edge.evidence}` : ""}`;
}

interface Point {
  x: number;
  y: number;
}

function positions(nodes: GraphNode[], center: string): Map<string, Point> {
  const points = new Map<string, Point>([[center, { x: WIDTH / 2, y: HEIGHT / 2 - 8 }]]);
  const outer = nodes.filter((node) => node.username !== center);
  const rings = outer.length <= 10 ? [outer.length] : outer.length <= 32 ? [10, outer.length - 10] : [10, 22, outer.length - 32];
  let offset = 0;
  rings.forEach((size, ringIndex) => {
    if (size <= 0) return;
    const radius = rings.length === 1 ? 192 : rings.length === 2 ? [126, 240][ringIndex] ?? 240 : [92, 172, 250][ringIndex] ?? 250;
    for (let index = 0; index < size; index += 1) {
      const node = outer[offset + index];
      if (!node) continue;
      const angle = -Math.PI / 2 + (index / size) * Math.PI * 2 + ringIndex * 0.14;
      points.set(node.username, {
        x: WIDTH / 2 + Math.cos(angle) * radius * 1.37,
        y: HEIGHT / 2 - 8 + Math.sin(angle) * radius,
      });
    }
    offset += size;
  });
  return points;
}

export function renderGraph(
  container: HTMLElement,
  dataset: Dataset,
  selected: string | undefined,
  onSelect: (username: string) => void,
): () => void {
  const model = buildGraphModel(dataset, selected);
  const id = `igunf-graph-${graphId++}`;
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const root = element("section", "connection-graph");
  root.setAttribute("aria-label", "Known Instagram connections");
  const heading = element("div", "connection-graph__heading");
  const headingText = element("div", "connection-graph__heading-text");
  headingText.append(
    element("span", "connection-graph__eyebrow", "YOUR SOCIAL CIRCLE"),
    element("h3", "connection-graph__title", model.focused && selected ? `Around @${selected}` : "A little perspective."),
  );
  const stats = element("p", "connection-graph__stats", `${model.nodes.length} accounts · ${model.edges.length} known connections`);
  heading.append(headingText, stats);
  root.append(heading);

  const canvas = element("div", "connection-graph__canvas");
  const surface = svg("svg", { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, class: "connection-graph__svg", role: "group", "aria-label": "Directed network. Select an account to inspect it. Drag the background to pan, and use the zoom controls.", tabindex: 0 });
  const defs = svg("defs");
  for (const kind of ["normal", "friend"] as const) {
    const marker = svg("marker", { id: `${id}-${kind}`, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse", markerUnits: "userSpaceOnUse" });
    marker.append(svg("path", { d: "M 1 1 L 7 4 L 1 7", fill: "none", stroke: kind === "friend" ? "#638b79" : "#a1a39a", "stroke-width": 1.2 }));
    defs.append(marker);
  }
  surface.append(defs);
  const viewport = svg("g");
  const center = model.focused && selected ? selected : dataset.owner;
  const points = positions(model.nodes, center);
  const guides = svg("g", { "aria-hidden": "true", class: "connection-graph__guides" });
  for (const radius of [100, 180, 260]) guides.append(svg("ellipse", { cx: WIDTH / 2, cy: HEIGHT / 2 - 8, rx: radius * 1.37, ry: radius, fill: "none", stroke: "#e7e8dd", "stroke-width": 1, "stroke-dasharray": "3 7" }));
  viewport.append(guides);
  const edgeLayer = svg("g", { class: "connection-graph__edges" });
  const edgeKeys = new Set(model.edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  const tooltip = element("div", "connection-graph__tooltip");
  tooltip.hidden = true;
  tooltip.setAttribute("role", "status");
  const revealTooltip = (content: string): void => {
    tooltip.textContent = content;
    tooltip.hidden = false;
  };
  const hideTooltip = (): void => { tooltip.hidden = true; };
  for (const edge of model.edges) {
    const from = points.get(edge.from);
    const to = points.get(edge.to);
    if (!from || !to) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const unit = { x: dx / distance, y: dy / distance };
    const startRadius = edge.from === center ? 31 : 22;
    const endRadius = edge.to === center ? 36 : 27;
    const start = { x: from.x + unit.x * startRadius, y: from.y + unit.y * startRadius };
    const end = { x: to.x - unit.x * endRadius, y: to.y - unit.y * endRadius };
    const curve = edgeKeys.has(`${edge.to}\u0000${edge.from}`) ? 13 : 0;
    const control = { x: (start.x + end.x) / 2 - unit.y * curve, y: (start.y + end.y) / 2 + unit.x * curve };
    const isFriendConnection = edge.from !== dataset.owner && edge.to !== dataset.owner && (dataset.friends.includes(edge.from) || dataset.friends.includes(edge.to));
    const description = edgeDescription(edge);
    const group = svg("g", { class: "connection-graph__edge", tabindex: 0, role: "img", "aria-label": description });
    const path = svg("path", { d: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`, fill: "none", stroke: isFriendConnection ? "#638b79" : "#b9bcb1", "stroke-width": isFriendConnection ? 1.9 : 1.2, "stroke-dasharray": edge.source === "export" ? "none" : "4 4", "marker-end": `url(#${id}-${isFriendConnection ? "friend" : "normal"})`, "vector-effect": "non-scaling-stroke" });
    const hit = svg("path", { d: path.getAttribute("d") ?? "", fill: "none", stroke: "transparent", "stroke-width": 12 });
    const title = svg("title");
    title.textContent = description;
    group.append(title, path, hit);
    group.addEventListener("mouseenter", () => revealTooltip(description), options);
    group.addEventListener("mouseleave", hideTooltip, options);
    group.addEventListener("focus", () => revealTooltip(description), options);
    group.addEventListener("blur", hideTooltip, options);
    edgeLayer.append(group);
  }
  viewport.append(edgeLayer);
  const nodesLayer = svg("g", { class: "connection-graph__nodes" });
  for (const node of model.nodes) {
    const point = points.get(node.username);
    if (!point) continue;
    const isCenter = node.username === center;
    const radius = isCenter ? 29 : 20;
    const labels: Record<NodeKind, string> = { owner: "Your account", friend: "Marked as a friend", nonreciprocal: "Does not follow you back in the imported snapshot", other: "Other account; friendship unknown" };
    const profile = dataset.profiles[node.username];
    const description = `@${node.username}${profile?.displayName ? ` · ${profile.displayName}` : ""}. ${labels[node.kind]}. Select to inspect connections.`;
    const group = svg("g", { transform: `translate(${point.x} ${point.y})`, class: `connection-graph__node connection-graph__node--${node.kind}${isCenter ? " connection-graph__node--center" : ""}`, tabindex: 0, role: "button", "aria-label": description, "aria-pressed": node.username === selected ? "true" : "false", "data-node": node.username });
    const title = svg("title");
    title.textContent = description;
    group.append(title);
    if (isCenter) group.append(svg("circle", { r: radius + 8, class: "connection-graph__halo", fill: "none", stroke: "#d7dccb", "stroke-width": 1 }));
    group.append(svg("circle", { r: radius, class: "connection-graph__disc", "stroke-width": 2 }));
    const initials = svg("text", { "text-anchor": "middle", "dominant-baseline": "central", class: "connection-graph__initials", "aria-hidden": "true", "font-size": isCenter ? 15 : 11 });
    initials.textContent = node.kind === "owner" ? "you" : node.username.replace(/[._]/g, "").slice(0, 2).toUpperCase();
    group.append(initials);
    if (model.nodes.length <= 30 || isCenter || node.kind === "friend") {
      const name = svg("text", { x: 0, y: radius + 19, "text-anchor": "middle", class: "connection-graph__label", "aria-hidden": "true" });
      name.textContent = node.username.length > 17 ? `${node.username.slice(0, 15)}…` : node.username;
      group.append(name);
    }
    const selectNode = (): void => onSelect(node.username);
    group.addEventListener("click", selectNode, options);
    group.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      selectNode();
    }, options);
    group.addEventListener("mouseenter", () => revealTooltip(description), options);
    group.addEventListener("mouseleave", hideTooltip, options);
    group.addEventListener("focus", () => revealTooltip(description), options);
    group.addEventListener("blur", hideTooltip, options);
    nodesLayer.append(group);
  }
  viewport.append(nodesLayer);
  surface.append(viewport);

  let scale = 1;
  let pan = { x: 0, y: 0 };
  const applyTransform = (): void => { viewport.setAttribute("transform", `translate(${pan.x} ${pan.y}) scale(${scale})`); };
  const zoom = (factor: number): void => {
    const next = Math.min(3, Math.max(0.45, scale * factor));
    pan = { x: WIDTH / 2 - (WIDTH / 2 - pan.x) * next / scale, y: HEIGHT / 2 - (HEIGHT / 2 - pan.y) * next / scale };
    scale = next;
    applyTransform();
  };
  const reset = (): void => { scale = 1; pan = { x: 0, y: 0 }; applyTransform(); };
  const controls = element("div", "connection-graph__controls");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Graph zoom");
  for (const [label, title, action] of [["−", "Zoom out", () => zoom(1 / 1.2)], ["+", "Zoom in", () => zoom(1.2)], ["↺", "Reset graph view", reset]] as const) {
    const button = element("button", "connection-graph__control", label);
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", action, options);
    controls.append(button);
  }
  let drag: { pointerId: number; x: number; y: number; panX: number; panY: number } | undefined;
  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("[data-node]"))) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    surface.setPointerCapture(event.pointerId);
    surface.classList.add("is-panning");
  }, options);
  surface.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = surface.getBoundingClientRect();
    const ratio = Math.max(WIDTH / Math.max(1, rect.width), HEIGHT / Math.max(1, rect.height));
    pan = { x: drag.panX + (event.clientX - drag.x) * ratio, y: drag.panY + (event.clientY - drag.y) * ratio };
    applyTransform();
  }, options);
  const endDrag = (): void => { drag = undefined; surface.classList.remove("is-panning"); };
  surface.addEventListener("pointerup", endDrag, options);
  surface.addEventListener("pointercancel", endDrag, options);
  surface.addEventListener("lostpointercapture", endDrag, options);
  surface.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { ...options, passive: false });
  surface.addEventListener("keydown", (event) => {
    if (event.target !== surface) return;
    if (event.key === "+" || event.key === "=") zoom(1.2);
    else if (event.key === "-") zoom(1 / 1.2);
    else if (event.key === "0") reset();
    else if (event.key.startsWith("Arrow")) {
      pan.x += event.key === "ArrowLeft" ? 25 : event.key === "ArrowRight" ? -25 : 0;
      pan.y += event.key === "ArrowUp" ? 25 : event.key === "ArrowDown" ? -25 : 0;
      applyTransform();
    } else return;
    event.preventDefault();
  }, options);
  canvas.append(surface, controls, tooltip);
  root.append(canvas);

  const footer = element("div", "connection-graph__footer");
  const legend = element("div", "connection-graph__legend");
  for (const [kind, text] of [["owner", "You"], ["friend", "Marked friend"], ["nonreciprocal", "Doesn’t follow back"], ["other", "Other / unknown"]] as const) {
    const item = element("span", "connection-graph__legend-item");
    item.append(element("i", `connection-graph__swatch connection-graph__swatch--${kind}`), document.createTextNode(text));
    legend.append(item);
  }
  footer.append(legend, element("p", "connection-graph__hint", "Arrows mean follows · Dashed lines are observations · Drag to pan"));
  root.append(footer);
  const notes = ["Only known connections are shown. A missing line is unknown, not evidence of no relationship."];
  if (!dataset.followersComplete || !dataset.followingComplete) notes.push("Your relationship import is incomplete, so missing follow-back relationships remain unknown.");
  if (model.omittedNodes > 0) notes.push(`${model.omittedNodes.toLocaleString()} more accounts are outside this view. Select an account in the list to focus its network.`);
  if (model.focused) notes.push("This view includes the selected account, you, and its known direct connections.");
  root.append(element("p", "connection-graph__note", notes.join(" ")));
  container.replaceChildren(root);
  return () => {
    controller.abort();
    root.remove();
  };
}
