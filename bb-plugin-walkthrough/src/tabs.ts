// A Walkthrough tab in the thread's persisted panel tabs, written by the
// server. The pane's own opener only runs in a client that is viewing the
// thread; a walkthrough that starts while nobody is looking (or that another
// device opens later) would otherwise have no tab. The tab's id is the one the
// host derives from the panel action and params, so a client opening the same
// panel later lands on this tab instead of making a second.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { tabTitle } from "./model.ts";
import { PANEL_ACTION_ID } from "./schemas.ts";

export function panelTabId(pluginId: string, walkthroughId: string): string {
  return `plugin-panel:${encodeURIComponent(`${pluginId}:${PANEL_ACTION_ID}:${paramsJson(walkthroughId)}`)}:none`;
}

const paramsJson = (walkthroughId: string) => JSON.stringify({ walkthroughId });

interface Tab {
  id: string;
  kind: string;
  title?: string;
  [key: string]: unknown;
}

type TabsArea = {
  get(args: { threadId: string }): Promise<{ revision: number; tabs: Tab[] }>;
  update(args: { threadId: string; expectedRevision: number; tabs: Tab[] }): Promise<unknown>;
};

const ATTEMPTS = 3;

export class WalkthroughTabs {
  /** Writes for one thread run one after another: each reads the revision the last one produced. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly bb: Pick<BbPluginApi, "pluginId" | "log" | "sdk">,
  ) {}

  /**
   * Makes sure the thread has a tab for the walkthrough, titled by what the
   * walkthrough is called so far. With `onlyIfPresent` an absent tab stays
   * absent (the reader closed it, or a starter tab shows this walkthrough).
   * Never throws: a missing tab is a convenience lost, not a failed walkthrough.
   */
  ensure(walkthrough: { id: string; threadId: string; title: string }, options: { onlyIfPresent?: boolean } = {}): Promise<boolean> {
    const previous = this.chains.get(walkthrough.threadId) ?? Promise.resolve();
    const run = previous.then(() => this.write(walkthrough, options.onlyIfPresent === true));
    const settled = run.catch(() => undefined);
    this.chains.set(walkthrough.threadId, settled);
    void settled.then(() => {
      if (this.chains.get(walkthrough.threadId) === settled) this.chains.delete(walkthrough.threadId);
    });
    return run.then(
      (written) => written,
      (cause) => {
        this.bb.log.warn(`could not persist the Walkthrough tab for ${walkthrough.threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        return false;
      },
    );
  }

  private async write(walkthrough: { id: string; threadId: string; title: string }, onlyIfPresent: boolean): Promise<boolean> {
    const area = (this.bb.sdk.threads as unknown as { tabs?: TabsArea }).tabs;
    if (!area) return false;
    const id = panelTabId(this.bb.pluginId, walkthrough.id);
    const title = tabTitle(walkthrough.title);
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const { revision, tabs } = await area.get({ threadId: walkthrough.threadId });
      const existing = tabs.find((tab) => tab.id === id);
      if (existing?.title === title) return true;
      if (!existing && onlyIfPresent) return false;
      const next: Tab[] = existing
        ? tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab))
        : [...tabs, { id, kind: "plugin-panel", pluginId: this.bb.pluginId, actionId: PANEL_ACTION_ID, paramsJson: paramsJson(walkthrough.id), title }];
      try {
        await area.update({ threadId: walkthrough.threadId, expectedRevision: revision, tabs: next });
        return true;
      } catch (cause) {
        // Another writer moved the revision between our read and write; read again.
        if (attempt === ATTEMPTS - 1) throw cause;
      }
    }
    return false;
  }
}
