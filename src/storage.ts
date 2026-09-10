import type { RunnerState, StoredState } from "./types.ts";

const DATABASE = "igunf-local";
const STORE = "state";
let opening: Promise<IDBDatabase> | undefined;

export function initialRunner(): RunnerState {
  return { status: "idle", message: "Ready", updatedAt: "1970-01-01T00:00:00.000Z" };
}

function database(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        opening = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => { opening = undefined; reject(request.error ?? new Error("Cannot open local storage.")); };
    request.onblocked = () => { opening = undefined; reject(new Error("Close other igunf pages to update local storage.")); };
  });
  return opening;
}

export async function readState(): Promise<StoredState> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get("current");
    let result: StoredState;
    request.onsuccess = () => { result = (request.result as StoredState | undefined) ?? { dataset: null, runner: initialRunner() }; };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error ?? new Error("Cannot read local storage."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot read local storage."));
  });
}

export async function updateState(mutator: (state: StoredState) => StoredState): Promise<StoredState> {
  const db = await database();
  return new Promise((resolve, reject) => {
    // The read and synchronous mutation share one readwrite transaction, including across extension contexts.
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get("current");
    let result: StoredState;
    request.onsuccess = () => {
      try {
        result = mutator((request.result as StoredState | undefined) ?? { dataset: null, runner: initialRunner() });
        store.put(result, "current");
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
    transaction.oncomplete = () => {
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel("igunf-state");
        channel.postMessage("updated");
        channel.close();
      }
      resolve(result);
    };
    transaction.onabort = () => reject(transaction.error ?? new Error("The local update was cancelled."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Cannot save local data."));
  });
}
