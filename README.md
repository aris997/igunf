# IgUnf — Your circle

A local-first Chrome extension for reviewing your Instagram following, recording relationships you actually know, and preparing a cleanup queue. You make the decisions; the graph shows the evidence behind them.

This first version includes a side panel, a full-page workspace, an interactive directed graph, local imports and backups, and an experimental browser adapter for approved unfollows. It does not train a graph neural network or obtain Instagram’s complete social graph.

## Install locally

Requires Node.js **22.22.2+ on 22.x**, **24.15.0+ on 24.x**, or **26+**, npm, and Chrome **120 or newer**. These minimums include the DOM test dependencies.

```bash
npm ci
npm run check
```

`check` runs TypeScript checking, the test suite, and the extension build. The generated extension is in `dist/`.

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository’s **dist** directory.
3. Pin **IgUnf — Your circle** from Chrome’s extensions menu.
4. Click its icon to open the side panel or the full-page workspace.
5. After changing code, run `npm run build`, then click **Reload** on the extension’s card.

The extension is built locally; it is not a published Chrome Web Store package. Loading the extension does not import account data or start Instagram actions.

## Try the interface with demo data

Choose **Try a demo** in the workspace, or run:

```bash
npm run build
npm run preview
```

Open [the local demo](http://127.0.0.1:4173/app.html?demo=1). The preview server listens on `127.0.0.1:4173`.

Demo accounts and changes live in memory and stay separate from your saved workspace. Leaving the demo restores your workspace. Instagram actions are disabled for demo datasets and in the ordinary browser preview. The preview and extension use separate storage origins.

## Import your Instagram snapshot

Request your Instagram information in **JSON** format, including followers and following, with the date range set to **All time**. An HTML export is unsupported.

In **Your data**:

1. Enter the username of the account whose data you exported.
2. Enter when the export was generated. Relationship entry timestamps record individual relationships and are not a substitute for the snapshot date.
3. Select the export ZIP, or select `following.json` and every `followers_1.json`, `followers_2.json`, … file from that same export. An unnumbered `followers.json` is also supported.
4. Check each completeness box only if that entire list is included from the same all-time export.
5. Import locally. Replacing an existing workspace requires confirmation.

The importer checks formats, usernames, profile URLs, duplicate accounts and files, missing numbered shards, and input sizes. It cannot independently prove that the export belongs to the entered username or that an omitted final shard exists. Verify those details yourself. If either completeness box is unchecked, absent relationships remain **unknown** and cannot enter the unfollow queue.

Limits: 100 selected files, 40 MiB combined input, 20 MiB per JSON file, and 80 MiB of expanded relationship data. Large, encrypted, multipart, or ZIP64 archives are unsupported; select the relationship JSON files directly instead.

A new import replaces the follower/following snapshot and clears pending actions. Same-account decisions, marked friends, recorded profile evidence, threshold, and completed action history are retained. Importing a different account creates a separate replacement workspace rather than mixing the accounts. Export a local backup first if you want to keep the old workspace.

## Review, connections, and big accounts

| Area | Behavior |
| --- | --- |
| **Review** | Inspect accounts, mark **Keep** or **Later**, or add a confirmed nonreciprocal account to the cleanup queue. Queuing is separate from executing. |
| **Connections** | Explore observed directed follows. Mark people you actually know as friends, then inspect which of them follow a selected account. |
| **Big accounts** | Queue every eligible account with a fresh exact follower count **strictly greater than** the configured threshold. The default is **20,000**. Friends and Keep decisions do not exempt accounts from this rule. |
| **Cleanup queue** | Review the proposed accounts and approve a batch before browser actions begin. View confirmed successes, failures, and pending items. |
| **Your data** | Import snapshots, change the threshold, export/restore a backup, or delete the local workspace. |

Queue eligibility requires complete follower and following lists and a snapshot no older than **7 days**. Big-account eligibility also requires an **exact follower count observed within 7 days**. A count of exactly 20,000 does not meet a 20,000 threshold. A rounded label such as “20K” or “20.1K” stays approximate and never qualifies on its own. Changing the threshold clears pending big-account entries so the next selection reflects the new rule.

Follow-back status starts with the imported snapshot. A newer recorded follow-back also prevents that account from qualifying for an unfollow. Instagram relationships can change afterward; import fresh data when reviewing a new cleanup session. Historical unfollows are retained for audit, while a newer snapshot can establish that you followed an account again.

### Reading the graph

- Arrows point from the follower to the account they follow.
- Dark nodes are you, green nodes are marked friends, orange nodes are confirmed nonreciprocal followings in the snapshot, and purple nodes are other or unknown accounts. Explicit friend markings take visual priority.
- Solid links come from imported relationships; dashed links represent manual or profile observations. Hover or focus a link to inspect its source and observation time.
- Select an account to focus on its known direct connections. The overview shows at most 70 accounts, prioritizing marked friends and nonreciprocal followings; an annotation reports omitted accounts.
- Drag the background to pan. Use the zoom buttons, or focus the graph and use `+`, `-`, `0`, and arrow keys. Nodes support Enter/Space selection.

An absent edge means **unknown**, not “these people are unrelated.” A shared connection is evidence to inspect, not proof that someone is your friend. Your export establishes your own follower/following relationships; connections between other people require additional observed evidence. There is no automatic crawling of friends’ networks and no GNN-based friendship score.

### Add evidence manually or from a profile

An account’s detail panel lets you record a full follower count you observed and a directed follow relationship. Record only relationships you have actually seen. Mark the other person as a friend to include them in the shared-friend evidence.

To capture visible profile evidence, open the relevant Instagram profile, click the extension icon, and choose **Save this profile’s evidence**. Capture runs on that page after your click. It can record:

- A follower count from an unambiguous profile header, preserving whether the count is exact or rounded.
- Named, visible links in supported **Followed by** / **Seguito da** profile text.
- Visible named rows in a supported followers/following dialog when its heading and route identify the list.

The adapter supports a narrow set of English and Italian labels. Hidden rows, unrecognized layouts, suggested-account lists, and ambiguous evidence are not treated as confirmed relationships. Instagram DOM changes may prevent capture or actions; use manual evidence when a page cannot be recognized. No scrolling or background network enumeration is performed.

## Experimental Instagram actions

Live actions require an imported personal workspace, a reviewed batch, the account username confirmation, and optional permission for `https://www.instagram.com/*`. The worker opens a dedicated Instagram tab, verifies the signed-in account and target profile, and processes one account at a time. An item is successful only after the supported target profile shows **Follow**.

Approval is bound to the exact pending queue, snapshot, threshold, and target identities. A changed approval list must be reviewed again. The Instagram confirmation dialog must explicitly identify the approved target; unlabelled or ambiguous dialogs stop the runner.

Pause stops subsequent steps and accounts. An already-dispatched confirmation may still complete; its result is checked before another action can start. A browser-worker interruption, ambiguous result, unsupported control, account mismatch, or Instagram restriction pauses the queue. Uncertain items are not retried automatically: inspect Instagram before explicitly queueing one again.

Browser automation can trigger Instagram restrictions. The delay between accounts is not a safe-rate guarantee. This adapter has **not been validated against a live Instagram account**, and development/testing did not send live unfollows. The automated tests use local fixtures and simulated browser operations; they cannot establish compatibility with the current live site. Keep the queue tab available and inspect any failure before resuming. Refollowing a private account later may require approval from that account.

## Data and permissions

The workspace is stored in **IndexedDB inside your local Chrome profile**. There is no backend, telemetry, account signup, cloud synchronization, or upload of imported files. The extension does not request your password or read cookies. Browser profile storage and exported JSON backups are not encrypted by this application; backups contain usernames, relationships, observations, decisions, and action history.

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporary access to the Instagram tab you explicitly invoke the extension on for capture. |
| `scripting` | Run the scoped DOM capture/action adapter in the selected Instagram tab. |
| `sidePanel` | Show the workspace beside Instagram. |
| `alarms` | Schedule the next approved queue item. |
| `storage` | Remember the dedicated queue tab for the current browser session. Main workspace data uses IndexedDB. |
| Optional Instagram host access | Navigate and inspect the queue’s Instagram profiles after batch approval. |

Extension-page network connections are blocked by its content security policy. Normal navigation and clicks on Instagram still communicate with Instagram through your signed-in browser session. You can revoke optional site access in Chrome’s extension settings; permission removal stops further queue steps.

**Export local backup** produces a versioned JSON file. Restoring replaces the local workspace and discards pending/running actions from the backup; it does not start a batch. **Delete local workspace** clears this extension’s saved dataset and history, without changing your Instagram account.

## Development

The app uses TypeScript, native DOM/SVG, and Chrome Manifest V3. Its only runtime package is `fflate`, for bounded local ZIP decompression. `esbuild` bundles extension entry points; Node’s test runner and DOM fixtures exercise core behavior.

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Dataset, evidence, queue, and extension-message types. |
| `src/importer.ts` | Bounded ZIP/JSON import and validated backup restoration. |
| `src/domain.ts` | Relationship classification, freshness, big-account selection, and queue eligibility. |
| `src/storage.ts` | Atomic IndexedDB updates shared across extension contexts. |
| `src/graph.ts`, `src/graph.css` | Deterministic interactive SVG network and presentation. |
| `src/app.ts` | Review workspace, manual evidence, imports, and batch approval. |
| `src/instagram.ts` | Self-contained injected DOM adapter and follower-count parsing. |
| `src/background.ts` | Persistent queue state, account checks, pauses, and restart recovery. |
| `src/popup.ts` | Side-panel/full-page launch and explicit current-profile capture. |
| `public/manifest.json` | Extension permissions, service worker, and content security policy. |

```bash
npm run typecheck
npm test
npm run build
# Or all three:
npm run check
```

Tests cover import completeness and malformed archives, backup validation, exact/rounded thresholds, relationship and graph evidence, safe rendering, queue eligibility, simulated action failures, pauses, and worker recovery. The graph uses deterministic radial positioning; there are no model downloads, training jobs, or external graph services.

## Continuous integration

[CI runs](https://github.com/aris997/igunf/actions/workflows/ci.yml) on pushes to `main`, pull requests, and manual dispatch. It installs the lockfile with `npm ci`, runs the type checker, all tests, and the extension build on Node 22, 24, and 26. Actions use pinned commit hashes and read-only repository permissions; no Instagram credentials or live account actions are involved.

Successful Node 26 jobs attach an `igunf-chrome-extension` artifact, including the project license and bundled dependency notices. Download and extract it, then load the extracted directory through Chrome’s **Load unpacked** action. Artifacts are retained for 14 days. This does not publish the extension to the Chrome Web Store.

## License

[MIT](LICENSE), copyright 2026 Riccardo Riva. The bundled `fflate` dependency is also MIT-licensed; its complete notice is included in every extension build as `THIRD_PARTY_NOTICES.txt`.
