import type { ProfileObservation } from "./types.ts";

export type InstagramTask =
  | { mode: "capture" }
  | { mode: "inspect" | "open" | "confirm" | "verify"; owner: string; username: string };

export interface InstagramPageResult {
  ok: boolean;
  message: string;
  username?: string;
  owner?: string;
  countText?: string;
  countTitle?: string;
  displayName?: string;
  edges?: ProfileObservation["edges"];
  following?: boolean;
}

/** Runs in an isolated extension world; every DOM helper must stay inside this function. */
export function instagramPageTask(task: InstagramTask): InstagramPageResult {
  const fail = (message: string): InstagramPageResult => ({ ok: false, message });
  const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();
  const name = (value: string): string | null => {
    const match = value.match(/^\/([a-zA-Z0-9._]{1,30})\/(?:\?.*)?$/);
    const username = match?.[1]?.toLowerCase();
    return username && !["accounts", "direct", "explore", "reels", "stories", "p", "reel"].includes(username) ? username : null;
  };
  const linkPath = (anchor: HTMLAnchorElement): string => {
    const url = new URL(anchor.href, location.origin);
    return url.origin === location.origin ? url.pathname : "";
  };
  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const label = (element: Element): string => clean(element.textContent).toLowerCase();
  const buttons = (scope: ParentNode): HTMLElement[] => [...scope.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(visible);
  if (location.hostname !== "www.instagram.com" || location.protocol !== "https:") return fail("Open an Instagram profile at https://www.instagram.com first.");
  if (/\/(?:accounts\/login|challenge|checkpoint|accounts\/suspended)/i.test(location.pathname)) return fail("Instagram requires login or an account check. The queue has stopped.");
  const pageText = clean(document.body?.innerText).toLowerCase();
  if (/(try again later|we restrict certain activity|action blocked|riprova più tardi|azione bloccata|limitiamo alcune attività|something went wrong|si è verificato un errore)/.test(pageText)) return fail("Instagram reported a restriction or error. No further action will run.");
  const route = location.pathname.match(/^\/([a-zA-Z0-9._]{1,30})\/(followers\/|following\/)?$/);
  const username = route?.[1]?.toLowerCase();
  if (!username || !name(`/${username}/`)) return fail("Open one person's profile. This page is not a supported profile route.");
  const headers = [...document.querySelectorAll("main header, header")].filter(visible);
  const header = headers.find((candidate) => [...candidate.querySelectorAll("h1, h2, a")].some((element) => label(element) === username));
  if (!header || headers.filter((candidate) => [...candidate.querySelectorAll("h1, h2, a")].some((element) => label(element) === username)).length !== 1) return fail("The profile header cannot be identified confidently.");
  const identities = new Set<string>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (!visible(anchor) || anchor.closest("header, main, [role=dialog]")) continue;
    const profileLabel = /^(profile|profilo)$/.test(label(anchor)) || /^(profile|profilo)$/i.test(clean(anchor.getAttribute("aria-label"))) || [...anchor.querySelectorAll("svg[aria-label]")].some((svg) => /^(profile|profilo)$/i.test(clean(svg.getAttribute("aria-label"))));
    if (profileLabel) {
      const candidate = name(linkPath(anchor));
      if (candidate) identities.add(candidate);
    }
  }
  const owner = identities.size === 1 ? [...identities][0] : undefined;
  if (task.mode !== "capture") {
    if (!owner || owner !== task.owner) return fail("The signed-in account could not be verified against the imported account. Open its Profile navigation link and try again.");
    if (username !== task.username || route?.[2]) return fail("The active profile changed. The queue has stopped.");
  }
  if (task.mode === "capture") {
    const followerLinks = [...header.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((anchor) => linkPath(anchor) === `/${username}/followers/` && visible(anchor));
    const followerLink = followerLinks.length === 1 ? followerLinks[0] : undefined;
    const titled = followerLink ? [...followerLink.querySelectorAll("[title]")].filter(visible) : [];
    const edges: ProfileObservation["edges"] = [];
    const add = (from: string, to: string, evidence: string): void => { if (from !== to && !edges.some((edge) => edge.from === from && edge.to === to)) edges.push({ from, to, evidence }); };
    for (const block of header.querySelectorAll("span, div")) {
      const text = clean(block.textContent);
      if (!visible(block) || text.length > 400 || !/^(followed by |seguito da |seguita da )/i.test(text)) continue;
      const links = [...block.querySelectorAll<HTMLAnchorElement>("a[href]")];
      // A bare phrase can occur in a user-written bio; require the accompanying Instagram followers link.
      if (!links.some((anchor) => visible(anchor) && (linkPath(anchor) === `/${username}/followers/` || linkPath(anchor).startsWith(`/${username}/followers/mutual`)))) continue;
      for (const anchor of links) {
        const other = name(linkPath(anchor));
        if (other && label(anchor) === other && visible(anchor)) add(other, username, "Visible ‘Followed by’ profile text");
      }
    }
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    if (route?.[2] && dialogs.length === 1) {
      const dialog = dialogs[0]!;
      const expectedHeading = route[2] === "followers/" ? /^(followers|follower)$/i : /^(following|seguiti|persone seguite)$/i;
      const hasHeading = [...dialog.querySelectorAll('h1, h2, h3, [role="heading"]')].some((element) => expectedHeading.test(clean(element.textContent)));
      const suggestions = /(suggested for you|suggeriti per te|suggested accounts)/i.test(clean(dialog.textContent));
      if (hasHeading && !suggestions) {
        for (const anchor of dialog.querySelectorAll<HTMLAnchorElement>('li a[href], [role="listitem"] a[href]')) {
          const other = name(linkPath(anchor));
          if (other && label(anchor) === other && visible(anchor)) {
            if (route[2] === "followers/") add(other, username, "Visible row in this profile’s Followers dialog");
            else add(username, other, "Visible row in this profile’s Following dialog");
          }
        }
      }
    }
    return { ok: true, message: "Visible profile evidence captured.", username, owner, countText: followerLink ? clean(followerLink.textContent) : undefined, countTitle: titled.length === 1 ? clean(titled[0]?.getAttribute("title")) : undefined, edges };
  }
  const controls = buttons(header);
  const following = controls.filter((button) => /^(following|segui già)$/i.test(clean(button.textContent)));
  const follow = controls.filter((button) => /^(follow|segui)$/i.test(clean(button.textContent)));
  if (task.mode === "verify") {
    if (follow.length === 1 && following.length === 0) return { ok: true, message: "Instagram now shows Follow on the target profile.", username, owner, following: false };
    return fail("Unfollow was not confirmed. Inspect Instagram before trying again; this account will not be retried automatically.");
  }
  if (following.length !== 1 || follow.length) return fail("Exactly one supported Following control was not found. No account was changed.");
  if (task.mode === "inspect") return { ok: true, message: "Account and Following control verified.", username, owner, following: true };
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  if (task.mode === "open") {
    if (dialogs.length) return fail("Close the existing Instagram dialog before starting the queue.");
    following[0]!.click();
    return { ok: true, message: "Opened Following options.", username, owner };
  }
  if (dialogs.length !== 1) return fail("One unambiguous unfollow confirmation dialog was not found.");
  const dialog = dialogs[0]!;
  const dialogText = clean(dialog.textContent);
  const dialogTargets = new Set<string>();
  for (const match of dialogText.matchAll(/@([a-z0-9._]{1,30})/gi)) dialogTargets.add(match[1]!.toLowerCase());
  for (const match of dialogText.matchAll(/(?:unfollow|non seguire più)\s+@?([a-z0-9._]{1,30})\s*\?/gi)) dialogTargets.add(match[1]!.toLowerCase());
  for (const anchor of dialog.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const target = name(linkPath(anchor));
    if (target && visible(anchor) && label(anchor).replace(/^@/, "") === target) dialogTargets.add(target);
  }
  if (dialogTargets.size !== 1 || !dialogTargets.has(task.username)) return fail("The unfollow dialog does not identify exactly the approved target account. No confirmation was clicked.");
  const unfollow = buttons(dialog).filter((button) => /^(unfollow|non seguire più)$/i.test(clean(button.textContent)));
  if (unfollow.length !== 1) return fail("The supported Unfollow confirmation was not found. No confirmation was clicked.");
  unfollow[0]!.click();
  return { ok: true, message: "Unfollow confirmation clicked; awaiting a verified result.", username, owner };
}

export function parseFollowerCount(text: string | undefined, title?: string): { value: number; exact: boolean } | undefined {
  const parseExact = (value: string): number | undefined => {
    const normalized = value.trim().replace(/[\u00a0\u202f]/g, " ");
    if (!/^\d+$/.test(normalized) && !/^\d{1,3}([,. ])\d{3}(?:\1\d{3})*$/.test(normalized)) return undefined;
    const count = Number(normalized.replace(/[, .]/g, ""));
    return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
  };
  if (title) { const value = parseExact(title); if (value !== undefined) return { value, exact: true }; }
  const raw = text?.trim().replace(/\s+(?:followers|follower)\s*$/i, "");
  if (!raw) return undefined;
  const exact = parseExact(raw);
  if (exact !== undefined) return { value: exact, exact: true };
  const abbreviated = raw.match(/^(\d+(?:[.,]\d+)?)\s*(k|m|b|mila|mln|mld)$/i);
  if (!abbreviated?.[1] || !abbreviated[2]) return undefined;
  const suffix = abbreviated[2].toLowerCase();
  const scale = suffix === "k" || suffix === "mila" ? 1_000 : suffix === "m" || suffix === "mln" ? 1_000_000 : 1_000_000_000;
  const value = Math.round(Number(abbreviated[1].replace(",", ".")) * scale);
  return Number.isSafeInteger(value) ? { value, exact: false } : undefined;
}

export function observationFromPage(result: InstagramPageResult, observedAt: string): ProfileObservation {
  if (!result.ok || !result.username) throw new Error(result.message);
  return { username: result.username, displayName: result.displayName, followerCount: parseFollowerCount(result.countText, result.countTitle), edges: result.edges ?? [], observedAt };
}
