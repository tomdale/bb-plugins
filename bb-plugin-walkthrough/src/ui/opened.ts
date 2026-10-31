// Which walkthroughs this client has already opened a tab for. The automatic
// opener must not reopen a tab the reader closed, so the memory outlives the
// page (localStorage); a client that has never seen a walkthrough, such as a
// second device or one that loaded the thread afterwards, still opens it once.

export function wasOpened(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null || sessionStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

export function markOpened(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Storage can be unavailable; opening twice is harmless.
  }
}
