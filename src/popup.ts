import type { ExtensionResponse } from "./types.ts";

const status = document.querySelector<HTMLElement>("#popup-status")!;
const capture = document.querySelector<HTMLButtonElement>("#capture")!;
const sidepanel = document.querySelector<HTMLButtonElement>("#sidepanel")!;
let currentWindowId: number | undefined;
sidepanel.disabled = true;
void chrome.windows.getCurrent().then((window) => {
  currentWindowId = window.id;
  sidepanel.disabled = currentWindowId === undefined;
}).catch((error: unknown) => { status.textContent = String(error); });

sidepanel.addEventListener("click", () => {
  if (currentWindowId === undefined) return;
  void chrome.sidePanel.open({ windowId: currentWindowId }).catch((error: unknown) => { status.textContent = String(error); });
});
document.querySelector("#dashboard")!.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});
capture.addEventListener("click", async () => {
  capture.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined || !tab.url?.startsWith("https://www.instagram.com/")) {
      throw new Error("Open an Instagram profile in this tab, then click IgUnf again.");
    }
    const response: ExtensionResponse = await chrome.runtime.sendMessage({ type: "capture", tabId: tab.id });
    status.textContent = response.message;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    capture.disabled = false;
  }
});
