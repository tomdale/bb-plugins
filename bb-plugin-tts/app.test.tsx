// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const app = await loadPluginApp(() => import("./app.js"));
const getContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext;
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = getContext;
});
afterEach(cleanup);

function assistantMessage(text = "A complete assistant response.") {
  return {
    id: "message_1",
    threadId: "thread_1",
    role: "assistant" as const,
    text,
    sourceSeqEnd: 12,
  };
}

describe("read aloud message action", () => {
  it("splits speech into sentence-aware requests under the Gateway limit", async () => {
    const { splitSpeechText } = await import("./app.js");
    const chunks = splitSpeechText(
      `${"A short sentence. ".repeat(30)}${"word ".repeat(130)}`,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 360)).toBe(true);
    expect(chunks.join(" ")).toContain("A short sentence.");
  });
  it("registers a per-message action that ignores user messages", () => {
    expect(app.messageActions).toHaveLength(1);
    expect(app.messageActions[0]).toMatchObject({
      id: "read-aloud",
      title: "Read response aloud / stop playback",
      icon: "Play",
    });
    vi.stubGlobal("fetch", vi.fn());
    const overlay = renderSlot(app.appOverlays[0]!, {}, { pluginId: "tts" });
    act(() =>
      app.messageActions[0]!.run({
        threadId: "thread_1",
        message: { ...assistantMessage(), role: "user" },
        openPanel: () => false,
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(overlay.queryByRole("region", { name: "Read aloud player" })).toBeNull();
    overlay.lifecycle.unmount();
  });

  it("fetches audio with the response text and stop aborts and releases playback", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchDeferred = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchDeferred),
    );
    const audio = {
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: vi.fn(),
    };
    vi.stubGlobal(
      "Audio",
      class {
        play = audio.play;
        pause = audio.pause;
        load = audio.load;
        removeAttribute = audio.removeAttribute;
        addEventListener = audio.addEventListener;

        constructor(readonly src: string) {
          expect(src).toBe("blob:tts-audio");
        }
      },
    );
    const createObjectURL = vi.fn(() => "blob:tts-audio");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const row = document.createElement("div");
    row.dataset.timelineRowId = "message_1";
    const messageColumn = document.createElement("div");
    messageColumn.dataset.messageColumn = "";
    row.append(messageColumn);
    document.body.append(row);
    const overlay = renderSlot(app.appOverlays[0]!, {}, { pluginId: "tts" });

    act(() => {
      app.messageActions[0]!.run({
        threadId: "thread_1",
        message: assistantMessage("**Hello** there"),
        openPanel: () => false,
      });
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        messageColumn.querySelector("[data-tts-inline-player]"),
      ).not.toBeNull(),
    );
    expect(messageColumn.textContent).toContain("Preparing audio…");
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("/api/v1/plugins/tts/http/speech");
    expect(JSON.parse(String(init?.body))).toEqual({
      threadId: "thread_1",
      text: "Hello there",
    });
    const signal = init?.signal as AbortSignal;

    await act(async () => {
      resolveFetch(
        new Response(new Uint8Array([1, 2]), {
          headers: { "content-type": "audio/mpeg" },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(audio.play).toHaveBeenCalledOnce());
    fireEvent.click(
      overlay.getByRole("button", { name: "Stop reading response aloud" }),
    );
    expect(signal.aborted).toBe(true);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:tts-audio");
    await waitFor(() =>
      expect(
        messageColumn.querySelector("[data-tts-inline-player]"),
      ).toBeNull(),
    );
    overlay.lifecycle.unmount();
    row.remove();
  });

  it("seeks within the current phrase using the waveform slider", async () => {
    const audioInstances: Array<{
      currentTime: number;
      duration: number;
      paused: boolean;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      ),
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => `blob:${audioInstances.length}`),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      "Audio",
      class {
        currentTime = 0;
        duration = 10;
        paused = false;
        play = vi.fn(async () => undefined);
        pause = vi.fn(() => {
          this.paused = true;
        });
        load = vi.fn();
        removeAttribute = vi.fn();
        addEventListener = vi.fn();
        constructor() {
          audioInstances.push(this);
        }
      },
    );
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        destination = {};
        close = vi.fn(async () => undefined);
        createMediaElementSource = vi.fn(() => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
        }));
        createAnalyser = vi.fn(() => ({
          fftSize: 0,
          frequencyBinCount: 64,
          connect: vi.fn(),
        }));
      },
    );
    const overlay = renderSlot(app.appOverlays[0]!, {}, { pluginId: "tts" });
    act(() =>
      app.messageActions[0]!.run({
        threadId: "thread_1",
        message: assistantMessage(),
        openPanel: () => false,
      }),
    );
    await waitFor(() => expect(audioInstances).toHaveLength(1));
    const slider = overlay.getByRole("slider", {
      name: "Seek in response audio",
    });
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    await waitFor(() => expect(audioInstances[0]?.currentTime).toBe(0.5));
    expect(slider.getAttribute("aria-valuenow")).toBe("5");
    overlay.lifecycle.unmount();
  });

  it("fetches and plays an unfetched phrase from the estimated offset", async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
    );
    const audioInstances: Array<{
      currentTime: number;
      duration: number;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
      load: ReturnType<typeof vi.fn>;
      removeAttribute: ReturnType<typeof vi.fn>;
    }> = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => `blob:${audioInstances.length}`),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      "Audio",
      class {
        currentTime = 0;
        duration = 10;
        paused = false;
        play = vi.fn(async () => undefined);
        pause = vi.fn();
        load = vi.fn();
        removeAttribute = vi.fn();
        addEventListener = vi.fn();
        constructor() {
          audioInstances.push(this);
        }
      },
    );
    const contexts: Array<{
      state: string;
      resume: ReturnType<typeof vi.fn>;
    }> = [];
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "suspended";
        resume = vi.fn(async () => {
          this.state = "running";
        });
        constructor() {
          contexts.push(this);
        }
        destination = {};
        close = vi.fn(async () => undefined);
        createMediaElementSource = vi.fn(() => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
        }));
        createAnalyser = vi.fn(() => ({
          fftSize: 0,
          frequencyBinCount: 64,
          connect: vi.fn(),
        }));
      },
    );
    const overlay = renderSlot(app.appOverlays[0]!, {}, { pluginId: "tts" });
    const text = `${"First phrase. ".repeat(20)}${"Second phrase. ".repeat(20)}`;
    act(() =>
      app.messageActions[0]!.run({
        threadId: "thread_1",
        message: assistantMessage(text),
        openPanel: () => false,
      }),
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]!(new Response(new Uint8Array([1, 2, 3])));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(audioInstances).toHaveLength(1));
    for (const context of contexts) {
      context.state = "suspended";
      context.resume.mockClear();
    }
    fireEvent.keyDown(overlay.getByRole("slider"), { key: "End" });
    expect(contexts[0]?.resume).toHaveBeenCalledOnce();
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]!(new Response(new Uint8Array([4, 5, 6])));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(audioInstances).toHaveLength(2));
    expect(audioInstances[1]?.currentTime).toBe(10);
    expect(contexts).toHaveLength(1);
    overlay.lifecycle.unmount();
  });

  it("ignores an abandoned seek when its phrase fetch resolves later", async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
    );
    const audioInstances: Array<{
      currentTime: number;
      duration: number;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      addEventListener: ReturnType<typeof vi.fn>;
      load: ReturnType<typeof vi.fn>;
      removeAttribute: ReturnType<typeof vi.fn>;
    }> = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => `blob:${audioInstances.length}`),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal(
      "Audio",
      class {
        currentTime = 0;
        duration = 10;
        paused = false;
        play = vi.fn(async () => undefined);
        pause = vi.fn();
        load = vi.fn();
        removeAttribute = vi.fn();
        addEventListener = vi.fn();
        constructor() {
          audioInstances.push(this);
        }
      },
    );
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        destination = {};
        close = vi.fn(async () => undefined);
        createMediaElementSource = vi.fn(() => ({
          connect: vi.fn(),
          disconnect: vi.fn(),
        }));
        createAnalyser = vi.fn(() => ({
          fftSize: 0,
          frequencyBinCount: 64,
          connect: vi.fn(),
        }));
      },
    );
    const overlay = renderSlot(app.appOverlays[0]!, {}, { pluginId: "tts" });
    const text = `${"First phrase. ".repeat(20)}${"Second phrase. ".repeat(20)}${"Third phrase. ".repeat(20)}`;
    act(() =>
      app.messageActions[0]!.run({
        threadId: "thread_1",
        message: assistantMessage(text),
        openPanel: () => false,
      }),
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]!(new Response(new Uint8Array([1, 2, 3])));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(audioInstances).toHaveLength(1));
    const slider = overlay.getByRole("slider");
    fireEvent.keyDown(slider, { key: "End" });
    await waitFor(() => expect(pending).toHaveLength(3));
    fireEvent.keyDown(slider, { key: "Home" });
    await act(async () => {
      pending[2]!(new Response(new Uint8Array([4, 5, 6])));
      await Promise.resolve();
      await Promise.resolve();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(audioInstances).toHaveLength(1);
    overlay.lifecycle.unmount();
  });

  it("cleans up in-flight playback on unmount", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchDeferred = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchDeferred),
    );
    const overlay = renderSlot(app.appOverlays[0]!, {}, { pluginId: "tts" });
    act(() =>
      app.messageActions[0]!.run({
        threadId: "thread_1",
        message: assistantMessage(),
        openPanel: () => false,
      }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const signal = vi.mocked(fetch).mock.calls[0]![1]?.signal as AbortSignal;
    overlay.lifecycle.unmount();
    expect(signal.aborted).toBe(true);
  });
});
