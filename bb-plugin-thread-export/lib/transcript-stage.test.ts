import { describe, expect, it } from "vitest";
import {
  findLoadOlderButton,
  loadOlderMessages,
  waitForStableTree,
} from "./transcript-stage.js";

function transcript(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("findLoadOlderButton", () => {
  it("finds bb's load-older control by its label", () => {
    const root = transcript(`
      <div><button>Copy</button><button><svg></svg> Load older messages </button></div>`);
    expect(findLoadOlderButton(root)?.textContent?.trim()).toBe("Load older messages");
  });

  it("returns null once bb stops offering older rows", () => {
    expect(findLoadOlderButton(transcript("<div><button>Copy</button></div>"))).toBeNull();
  });

  it("is not fooled by a tool row whose command mentions older rows", () => {
    const root = transcript(`
      <div><button>Ran grep -n "load older" src/</button>
      <button>Load older messages</button></div>`);
    expect(findLoadOlderButton(root)?.textContent?.trim()).toBe("Load older messages");
  });
});

describe("loadOlderMessages", () => {
  it("clicks until the control disappears", async () => {
    const root = transcript("<div id='host'><button>Load older messages</button></div>");
    const host = root.querySelector("#host");
    let clicks = 0;
    root.querySelector("button")?.addEventListener("click", () => {
      clicks += 1;
      if (clicks >= 3) root.querySelector("button")?.remove();
    });

    const result = await loadOlderMessages(root);

    expect(host).not.toBeNull();
    expect(clicks).toBe(3);
    expect(result.exhausted).toBe(true);
    expect(result.rounds).toBe(3);
  });

  it("waits for a page in flight instead of giving up", async () => {
    const root = transcript("<div><button disabled>Load older messages</button></div>");
    const button = root.querySelector("button");
    setTimeout(() => {
      button?.removeAttribute("disabled");
      button?.addEventListener("click", () => button.remove());
    }, 50);

    const result = await loadOlderMessages(root);

    expect(result.exhausted).toBe(true);
    expect(result.rounds).toBe(1);
  });

  it("stops when the export is cancelled", async () => {
    const root = transcript("<div><button>Load older messages</button></div>");
    const result = await loadOlderMessages(root, { isCancelled: () => true });
    expect(result.rounds).toBe(0);
    expect(result.exhausted).toBe(false);
  });

  it("stays bounded on a thread that never finishes loading", async () => {
    const root = transcript("<div><button>Load older messages</button></div>");
    const result = await loadOlderMessages(root, { maxRounds: 2 });
    expect(result.rounds).toBe(2);
    expect(result.exhausted).toBe(false);
  });
});

describe("waitForStableTree", () => {
  it("settles on a static tree", async () => {
    const root = transcript("<div><p>One</p><p>Two</p></div>");
    await expect(
      waitForStableTree(root, { intervalMs: 5, samples: 2, timeoutMs: 200 }),
    ).resolves.toBe(true);
  });

  it("reports a tree that never stops changing", async () => {
    const root = transcript("<div></div>");
    const timer = setInterval(() => {
      root.append(document.createElement("span"));
    }, 2);
    const settled = await waitForStableTree(root, {
      intervalMs: 4,
      samples: 10,
      timeoutMs: 60,
    });
    clearInterval(timer);
    expect(settled).toBe(false);
  });
});
