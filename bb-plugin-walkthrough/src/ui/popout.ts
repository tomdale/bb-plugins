// Opening a walkthrough in a window of its own.
//
// The window loads BB at the walkthrough's nav-panel route, so it is a full BB
// page showing only that walkthrough. BB's desktop app hands `window.open` to
// the system browser instead of creating a BB window; a browser client opens a
// real popup window.
import { PAGE_PATH } from "../schemas.ts";

/** The route BB serves for a nav panel's sub-page (`/plugins/<pluginId>/<path>/<subPath>`). */
export function pageRoutePath(pluginId: string, walkthroughId: string): string {
  return `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(PAGE_PATH)}/${encodeURIComponent(walkthroughId)}`;
}

const POPUP_FEATURES = "popup,width=1100,height=820";

// Windows opened by this tab, so a second click focuses the window instead of
// navigating it (which would reload it and lose its reading position). The
// desktop app yields no handle, so there each click opens the page again.
const opened = new Map<string, Window>();

export function popOut(pluginId: string, walkthroughId: string): void {
  const existing = opened.get(walkthroughId);
  if (existing && !existing.closed) {
    existing.focus();
    return;
  }
  const url = new URL(pageRoutePath(pluginId, walkthroughId), window.location.origin).href;
  const popup = window.open(url, `${pluginId}:${walkthroughId}`, POPUP_FEATURES);
  if (popup) opened.set(walkthroughId, popup);
  else opened.delete(walkthroughId);
}
