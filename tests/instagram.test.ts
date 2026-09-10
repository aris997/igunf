import assert from "node:assert/strict";
import test from "node:test";
import { instagramPageTask, observationFromPage, parseFollowerCount } from "../src/instagram.ts";
import type { InstagramTask } from "../src/instagram.ts";

test("counts distinguish exact grouped values from rounded English and Italian abbreviations", () => {
  assert.deepEqual(parseFollowerCount("20.1K followers", "20,123"), { value: 20_123, exact: true });
  assert.deepEqual(parseFollowerCount("20.001 follower"), { value: 20_001, exact: true });
  assert.deepEqual(parseFollowerCount("20,1 mila follower"), { value: 20_100, exact: false });
  assert.deepEqual(parseFollowerCount("1.2M followers"), { value: 1_200_000, exact: false });
  assert.deepEqual(parseFollowerCount("0 followers"), { value: 0, exact: true });
  for (const text of ["20.1 followers", "1,23,456 followers", "12 posts 30 followers", "unknown", "-4", "9007199254740993"]) assert.equal(parseFollowerCount(text), undefined, text);
});

class ElementFixture {
  textContent: string;
  href = "";
  attributes: Record<string, string> = {};
  selectors: Record<string, ElementFixture[]> = {};
  rendered = true;
  insideMain = false;
  clicks = 0;
  onClick = (): void => {};
  constructor(text = "") { this.textContent = text; }
  querySelectorAll(selector: string): ElementFixture[] { return this.selectors[selector] ?? []; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  getClientRects(): object[] { return this.rendered ? [{}] : []; }
  closest(selector: string): ElementFixture | null { return selector.includes("main") && this.insideMain ? this : null; }
  click(): void { this.clicks += 1; this.onClick(); }
}

function fixture(options: { owner?: string; target?: string; label?: string; countTitle?: string; pageText?: string } = {}) {
  const target = options.target ?? "alice";
  const header = new ElementFixture();
  const heading = new ElementFixture(target);
  const following = new ElementFixture(options.label ?? "Following");
  const follow = new ElementFixture("Follow");
  const unfollow = new ElementFixture("Unfollow");
  const dialog = new ElementFixture(`Unfollow @${target}?`);
  dialog.selectors['button, [role="button"]'] = [unfollow];
  const nav = new ElementFixture("Profile");
  nav.href = `https://www.instagram.com/${options.owner ?? "me"}/`;
  const count = new ElementFixture("20.1K followers");
  count.href = `https://www.instagram.com/${target}/followers/`;
  count.insideMain = true;
  const countTitle = new ElementFixture();
  countTitle.attributes.title = options.countTitle ?? "20,123";
  count.selectors["[title]"] = [countTitle];
  header.selectors["h1, h2, a"] = [heading];
  header.selectors['button, [role="button"]'] = [following];
  header.selectors["a[href]"] = [count];
  const documentFixture = new ElementFixture();
  documentFixture.selectors["main header, header"] = [header];
  documentFixture.selectors["a[href]"] = [nav, count];
  documentFixture.selectors['[role="dialog"]'] = [];
  following.onClick = () => { documentFixture.selectors['[role="dialog"]'] = [dialog]; };
  unfollow.onClick = () => {
    header.selectors['button, [role="button"]'] = [follow];
    documentFixture.selectors['[role="dialog"]'] = [];
  };
  const run = (task: InstagramTask, path = `/${target}/`) => {
    const names = ["document", "location", "getComputedStyle"] as const;
    const saved = names.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "document", { value: Object.assign(documentFixture, { body: { innerText: options.pageText ?? "" } }), configurable: true });
    Object.defineProperty(globalThis, "location", { value: { protocol: "https:", hostname: "www.instagram.com", origin: "https://www.instagram.com", pathname: path }, configurable: true });
    Object.defineProperty(globalThis, "getComputedStyle", { value: () => ({ display: "block", visibility: "visible" }), configurable: true });
    try { return instagramPageTask(task); }
    finally {
      names.forEach((key, index) => { const descriptor = saved[index]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    }
  };
  return { run, following, follow, unfollow, dialog, nav, count, header, documentFixture };
}

test("capture reads only visible, correctly attributed follower counts", () => {
  const page = fixture();
  const result = observationFromPage(page.run({ mode: "capture" }), "2026-09-10T12:00:00.000Z");
  assert.equal(result.username, "alice");
  assert.deepEqual(result.followerCount, { value: 20_123, exact: true });
  assert.deepEqual(result.edges, []);
  assert.equal(page.following.clicks, 0);
  page.count.href = "https://unrelated.example/alice/followers/";
  assert.equal(observationFromPage(page.run({ mode: "capture" }), result.observedAt).followerCount, undefined);
});

test("wrong identity, unsupported controls, changed routes, and restrictions fail before any click", () => {
  for (const page of [fixture({ owner: "other" }), fixture({ label: "Follow" }), fixture({ label: "Requested" }), fixture({ pageText: "Try again later" })]) {
    assert.equal(page.run({ mode: "open", owner: "me", username: "alice" }).ok, false);
    assert.equal(page.following.clicks, 0);
  }
  const page = fixture();
  assert.equal(page.run({ mode: "open", owner: "me", username: "bob" }).ok, false);
  assert.equal(page.run({ mode: "open", owner: "me", username: "alice" }, "/accounts/login/").ok, false);
  assert.equal(page.following.clicks, 0);
});

test("confirmation is scoped to exactly one dialog and success requires Follow on the same account", () => {
  const page = fixture();
  const task = { owner: "me", username: "alice" };
  assert.equal(page.run({ ...task, mode: "inspect" }).following, true);
  assert.equal(page.run({ ...task, mode: "confirm" }).ok, false);
  assert.equal(page.run({ ...task, mode: "verify" }).ok, false);
  assert.equal(page.run({ ...task, mode: "open" }).ok, true);
  assert.equal(page.following.clicks, 1);
  assert.equal(page.run({ ...task, mode: "confirm" }).ok, true);
  assert.equal(page.unfollow.clicks, 1);
  assert.equal(page.run({ ...task, mode: "verify" }).following, false);
  assert.equal(page.follow.clicks, 0);
});

test("duplicate dialogs and translated or changed controls fail closed", () => {
  const page = fixture({ label: "Segui già" });
  const task = { owner: "me", username: "alice" };
  assert.equal(page.run({ ...task, mode: "open" }).ok, true);
  page.documentFixture.selectors['[role="dialog"]'] = [page.dialog, new ElementFixture()];
  assert.equal(page.run({ ...task, mode: "confirm" }).ok, false);
  assert.equal(page.unfollow.clicks, 0);
  page.documentFixture.selectors['[role="dialog"]'] = [page.dialog];
  page.unfollow.textContent = "Non seguire più";
  assert.equal(page.run({ ...task, mode: "confirm" }).ok, true);
});

test("a confirmation for another account, an unnamed target, or ambiguous targets never clicks", () => {
  for (const text of ["Unfollow @bob?", "Unfollow?", "Unfollow @alice or @bob?", "Unfollow alice_else?"]) {
    const page = fixture();
    const task = { owner: "me", username: "alice" };
    assert.equal(page.run({ ...task, mode: "open" }).ok, true);
    page.dialog.textContent = text;
    const result = page.run({ ...task, mode: "confirm" });
    assert.equal(result.ok, false, text);
    assert.match(result.message, /approved target/);
    assert.equal(page.unfollow.clicks, 0);
  }
});

test("a confirmation may identify the target with a precise prompt or profile link", () => {
  for (const text of ["Unfollow alice?", "Non seguire più @alice?", "Unfollow?"]) {
    const page = fixture();
    const task = { owner: "me", username: "alice" };
    assert.equal(page.run({ ...task, mode: "open" }).ok, true);
    page.dialog.textContent = text;
    if (text === "Unfollow?") {
      const profile = new ElementFixture("alice"); profile.href = "https://www.instagram.com/alice/";
      page.dialog.selectors["a[href]"] = [profile];
    }
    assert.equal(page.run({ ...task, mode: "confirm" }).ok, true, text);
    assert.equal(page.unfollow.clicks, 1);
  }
});

test("mutual evidence only attributes visible same-origin named links in explicit Followed by text", () => {
  const page = fixture();
  const mutual = new ElementFixture("Followed by friend, other");
  const friend = new ElementFixture("friend"); friend.href = "https://www.instagram.com/friend/";
  const other = new ElementFixture("other"); other.href = "https://unrelated.example/other/";
  const hidden = new ElementFixture("hidden"); hidden.href = "https://www.instagram.com/hidden/"; hidden.rendered = false;
  mutual.selectors["a[href]"] = [friend, other, hidden];
  page.header.selectors["span, div"] = [mutual];
  assert.deepEqual(page.run({ mode: "capture" }).edges, []);
  const followersLink = new ElementFixture("2 others"); followersLink.href = "https://www.instagram.com/alice/followers/";
  mutual.selectors["a[href]"].push(followersLink);
  assert.deepEqual(page.run({ mode: "capture" }).edges?.map(({ from, to }) => [from, to]), [["friend", "alice"]]);
});
