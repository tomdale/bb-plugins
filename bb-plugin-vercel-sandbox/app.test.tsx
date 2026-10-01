// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PROVIDER_ID } from "./provider-id.js";

const app = await loadPluginApp(() => import("./app"));

const LAUNCH_OPTIONS = {
  image: "vercel/sandbox/universal:latest",
  defaultInputs: { vcpus: 2, timeoutMinutes: 30 },
  limits: {
    minVcpus: 1,
    maxVcpus: 32,
    allowedVcpus: [
      1,
      ...Array.from({ length: 16 }, (_, index) => (index + 1) * 2),
    ],
    minTimeoutMinutes: 5,
    maxTimeoutMinutes: 1440,
  },
  memoryMiBPerVcpu: 2048,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function mockViewport(compact: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: compact && query.includes("max-width"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  mockViewport(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function inputsSlot() {
  const registration = app.machineProviderInputs.find(
    (candidate) => candidate.machineProviderId === PROVIDER_ID,
  );
  if (registration === undefined) throw new Error("inputs not registered");
  return registration;
}

function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

describe("registrations", () => {
  it("registers only the launch control, settings section, and expiry indicator", () => {
    expect(
      app.machineProviderInputs.map((slot) => slot.machineProviderId),
    ).toEqual([PROVIDER_ID]);
    expect(app.settingsSections.map((slot) => slot.id)).toEqual(["sandbox"]);
    expect(app.threadHeaderActions.map((slot) => slot.id)).toEqual(["expiry"]);
    expect(app.navPanels).toEqual([]);
  });
});

describe("launch inputs control", () => {
  it("submits defaults immediately and shows the effective launch", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    expect(onChange).toHaveBeenCalledWith({ status: "ready", value: {} });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: 2 vCPU, stops after 30 minutes",
    });
    expect(trigger.textContent).toContain("2 vCPU · 30 min");
    expect(trigger.textContent).toContain("2 · 30m");
    expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: {} });
  });

  it("states the data-loss and plan boundaries where the choice is made", async () => {
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange: vi.fn() },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    openMenu(await slot.findByRole("button", { name: /2 vCPU/ }));
    await slot.findByText(/stops for good at its time limit/);
    expect(
      slot.getByText(/BB can't extend, pause, or restore it/),
    ).toBeTruthy();
    expect(slot.getByText(/Choices are Vercel maximums/)).toBeTruthy();
    const eight = slot.getByRole("menuitemradio", { name: /8 vCPU · 16 GiB/ });
    expect(eight.textContent).toContain("Pro+");
    const thirtyTwo = slot.getByRole("menuitemradio", {
      name: /32 vCPU · 64 GiB/,
    });
    expect(thirtyTwo.textContent).toContain("Enterprise");
    expect(
      slot
        .getByRole("menuitemradio", { name: /2 vCPU · 4 GiB \(default\)/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      slot.getByRole("menuitemradio", { name: /^24 h/ }).textContent,
    ).toContain("Pro+");
    expect(
      slot.getByRole("menuitemradio", { name: /^45 min/ }).textContent,
    ).not.toContain("Pro+");
  });

  it("emits a complete explicit selection after a pick", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    openMenu(await slot.findByRole("button", { name: /2 vCPU/ }));
    fireEvent.click(
      await slot.findByRole("menuitemradio", { name: /8 vCPU · 16 GiB/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { vcpus: 8, timeoutMinutes: 30 },
    });
  });

  it("keeps a seeded choice and lists it even off the ladder", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: { vcpus: 6, timeoutMinutes: 90 }, onChange },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: 6 vCPU, stops after 1 hour 30 minutes",
    });
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { vcpus: 6, timeoutMinutes: 90 },
    });
    openMenu(trigger);
    expect(
      (
        await slot.findByRole("menuitemradio", { name: /6 vCPU · 12 GiB/ })
      ).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      slot
        .getByRole("menuitemradio", { name: /1 h 30 min/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("blocks a stale out-of-range selection until a new choice is made", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: { vcpus: 8 }, onChange },
      {
        rpc: {
          "launch.options": () => ({
            ...LAUNCH_OPTIONS,
            limits: {
              ...LAUNCH_OPTIONS.limits,
              maxVcpus: 4,
              allowedVcpus: [1, 2, 4],
            },
          }),
        },
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: choose new options",
    });
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({
        status: "blocked",
        reason: expect.stringContaining(
          "8 vCPU isn't available. Vercel allows 1, 2, 4 vCPUs",
        ),
      });
    });
    openMenu(trigger);
    fireEvent.click(
      await slot.findByRole("menuitemradio", { name: /4 vCPU · 8 GiB/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { vcpus: 4, timeoutMinutes: 30 },
    });
  });

  it("blocks a seeded odd vCPU count above one that Vercel rejects", () => {
    const onChange = vi.fn();
    renderSlot(
      inputsSlot(),
      { value: { vcpus: 3, timeoutMinutes: 30 }, onChange },
      { rpc: { "launch.options": () => new Promise(() => {}) } },
    );
    expect(onChange).toHaveBeenLastCalledWith({
      status: "blocked",
      reason: expect.stringContaining("Vercel accepts 1 or an even number"),
    });
  });

  it("renders the backend's allowed vCPU list unchanged", async () => {
    const slot = renderSlot(
      inputsSlot(),
      { value: { vcpus: 6 }, onChange: vi.fn() },
      {
        rpc: {
          "launch.options": () => ({
            ...LAUNCH_OPTIONS,
            limits: {
              ...LAUNCH_OPTIONS.limits,
              allowedVcpus: [1, 2, 4, 6, 8],
            },
          }),
        },
      },
    );
    openMenu(await slot.findByRole("button", { name: /6 vCPU/ }));
    const counts = (await slot.findAllByRole("menuitemradio"))
      .map((item) => /^(\d+) vCPU/.exec(item.textContent ?? "")?.[1])
      .filter((count): count is string => count !== undefined)
      .map(Number);
    expect(counts).toEqual([1, 2, 4, 6, 8]);
    expect(
      slot
        .getByRole("menuitemradio", { name: /^6 vCPU · 12 GiB/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("groups each radio set and describes the menu with its warnings", async () => {
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange: vi.fn() },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    openMenu(await slot.findByRole("button", { name: /2 vCPU/ }));
    const vcpu = await slot.findByRole("group", { name: "vCPU" });
    const stops = slot.getByRole("group", { name: "Stops after" });
    expect(vcpu.querySelectorAll('[role="menuitemradio"]').length).toBe(17);
    expect(stops.querySelectorAll('[role="menuitemradio"]').length).toBe(8);
    const menu = slot.getByRole("menu");
    const described = (menu.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain("stops for good at its time limit");
    expect(described).toContain("Choices are Vercel maximums");
  });

  it("names the saved choice, not the defaults, when options fail", async () => {
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: { vcpus: 6, timeoutMinutes: 90 }, onChange },
      {
        rpc: {
          "launch.options": () => {
            throw new Error("offline");
          },
        },
      },
    );
    openMenu(
      await slot.findByRole("button", {
        name: "Vercel sandbox: 6 vCPU, stops after 1 hour 30 minutes",
      }),
    );
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain(
      "saved choice (6 vCPU, stops after 1 h 30 min)",
    );
    expect(alert.textContent).not.toContain("defaults");
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { vcpus: 6, timeoutMinutes: 90 },
    });
  });

  it.each([
    ["an unknown key", { preset: "Large" }],
    ["a fractional vCPU count", { vcpus: 1.5 }],
    ["a non-object value", "Large"],
  ])("blocks %s without waiting for options", (_label, value) => {
    const onChange = vi.fn();
    renderSlot(
      inputsSlot(),
      { value, onChange },
      { rpc: { "launch.options": () => new Promise(() => {}) } },
    );
    expect(onChange).toHaveBeenLastCalledWith({
      status: "blocked",
      reason: expect.stringContaining("invalid"),
    });
  });

  it("stays submittable when options fail and recovers on retry", async () => {
    const onChange = vi.fn();
    let calls = 0;
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange },
      {
        rpc: {
          "launch.options": () => {
            calls += 1;
            if (calls === 1)
              throw new Error("vendor said: token abc123 rejected");
            return LAUNCH_OPTIONS;
          },
        },
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: options unavailable",
    });
    expect(onChange).toHaveBeenLastCalledWith({ status: "ready", value: {} });
    openMenu(trigger);
    expect((await slot.findByRole("alert")).textContent).toContain(
      "Couldn't load Vercel launch options",
    );
    expect(slot.queryByText(/abc123/)).toBeNull();
    expect(slot.getByText(/stops for good/)).toBeTruthy();
    fireEvent.click(slot.getByRole("menuitem", { name: "Retry" }));
    await slot.findByRole("menuitemradio", { name: /2 vCPU · 4 GiB/ });
    expect(calls).toBe(2);
  });

  it("ignores a launch options response that lands after unmount", async () => {
    const pending = deferred<typeof LAUNCH_OPTIONS>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange: vi.fn() },
      { rpc: { "launch.options": () => pending.promise } },
    );
    slot.lifecycle.unmount();
    await act(async () => {
      pending.resolve(LAUNCH_OPTIONS);
      await pending.promise;
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("opens the same choices and warning in the compact drawer", async () => {
    mockViewport(true);
    const onChange = vi.fn();
    const slot = renderSlot(
      inputsSlot(),
      { value: null, onChange },
      { rpc: { "launch.options": () => LAUNCH_OPTIONS } },
    );
    fireEvent.click(await slot.findByRole("button", { name: /2 vCPU/ }));
    await slot.findByText(/stops for good at its time limit/);
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /^1 h/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      status: "ready",
      value: { vcpus: 2, timeoutMinutes: 60 },
    });
  });
});

describe("settings section", () => {
  type Account = {
    available: boolean;
    message: string;
    hostId: string | null;
    directory: string | null;
    accountId: string | null;
    accountName: string | null;
    teamId: string | null;
    projectId: string | null;
    legacyAllocations: {
      count: number;
      teamId: string;
      projectId: string;
    } | null;
    adoptedAllocations: number;
  };

  const NOT_CONNECTED: Account = {
    available: false,
    message: "Run vc login and vc link on a machine, then connect it.",
    hostId: null,
    directory: null,
    accountId: null,
    accountName: null,
    teamId: null,
    projectId: null,
    legacyAllocations: null,
    adoptedAllocations: 0,
  };

  const CONNECTED: Account = {
    available: true,
    message: "Connected",
    hostId: "host-mac",
    directory: "/Users/me/vercel-bb",
    accountId: "user_abc",
    accountName: "tom",
    teamId: "team_abc",
    projectId: "prj_def",
    legacyAllocations: null,
    adoptedAllocations: 0,
  };

  const LEGACY = { count: 2, teamId: "team_abc", projectId: "prj_def" };

  const TOKEN_SHAPED = /eyJ|vca_|Bearer|token=/i;

  function safeError(message: string) {
    return Object.assign(new Error(message), { code: "handler_error" });
  }

  function settingsSlot() {
    const section = app.settingsSections[0];
    if (section === undefined) throw new Error("settings not registered");
    return section;
  }

  function host(
    id: string,
    name: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id,
      name,
      type: "persistent",
      status: "connected",
      machineProviderId: null,
      lifecycle: { phase: "active", teardown: null },
      ...overrides,
    };
  }

  const HOSTS = [
    host("host-mac", "Tom's MacBook"),
    host("host-studio", "Studio", { status: "disconnected" }),
    host("host-linux", "Build box"),
    host("host-sandbox", "vercel-sandbox-1", {
      type: "ephemeral",
      machineProviderId: PROVIDER_ID,
    }),
    host("host-gone", "Old laptop", {
      lifecycle: { phase: "destroyed", teardown: null },
    }),
  ];

  function renderSettings(
    rpc: Record<string, (input: never) => unknown>,
    hostsList: () => unknown = () => HOSTS,
  ) {
    return renderSlot(
      settingsSlot(),
      {},
      {
        rpc: { "launch.options": () => LAUNCH_OPTIONS, ...rpc } as never,
        sdk: { hosts: { list: hostsList } } as never,
      },
    );
  }

  function connectCalls(slot: ReturnType<typeof renderSettings>) {
    return slot.inspection.rpcCalls.filter(
      (call) => call.method === "account.connect",
    );
  }

  it("names the machine and linked project without claiming launch entitlement", async () => {
    const slot = renderSettings({ "account.inspect": () => CONNECTED });
    await slot.findByText(
      "Connected. New sandboxes use the Vercel CLI on Tom's MacBook.",
    );
    expect(
      slot.getByText(/doesn't confirm your plan's sandbox limits/),
    ).toBeTruthy();
    const details = slot
      .getByText("Linked folder", { selector: "dt" })
      .closest("dl");
    expect(details?.textContent).toContain("/Users/me/vercel-bb");
    expect(details?.textContent).toContain("tom (user_abc)");
    expect(details?.textContent).toContain("team_abc");
    expect(details?.textContent).toContain("prj_def");
    expect(
      slot.getByRole("heading", { name: "Change connection" }),
    ).toBeTruthy();
    expect(
      (slot.getByLabelText("Linked folder") as HTMLInputElement).value,
    ).toBe("/Users/me/vercel-bb");
    expect(
      slot.getByRole("button", { name: /Machine Tom's MacBook/ }),
    ).toBeTruthy();
    expect(slot.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(slot.getByText("2 vCPU · 4 GiB")).toBeTruthy();
    expect(slot.getByText("30 min")).toBeTruthy();
    expect(slot.getByText("1–32 vCPU, 5 min–24 h")).toBeTruthy();
    expect(slot.getByText(/stops for good at its time limit/)).toBeTruthy();
    expect(
      slot.getByText(/Vercel bills your team while a sandbox runs/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(TOKEN_SHAPED);
    expect(slot.queryByLabelText(/token/i)).toBeNull();
    expect(
      slot.getByText(
        /This page can't remove an access token saved by an earlier/,
      ).textContent,
    ).toContain("revoke that token in Vercel");
    expect(
      slot.queryByText(/until someone removes it|Remove it there/),
    ).toBeNull();
  });

  it("guides terminal sign-in and linking when nothing is connected", async () => {
    const slot = renderSettings({ "account.inspect": () => NOT_CONNECTED });
    await slot.findByText(/Not connected/);
    expect(slot.getByText(NOT_CONNECTED.message)).toBeTruthy();
    expect(slot.getByRole("heading", { name: "Set up" })).toBeTruthy();
    const steps = within(
      slot.getByRole("form", { name: "Connect the Vercel CLI" }),
    )
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(steps[0]).toContain("vc login");
    expect(steps[0]).toContain("same OS user that runs BB");
    expect(steps[0]).toContain("58.3.0 or later");
    expect(steps[1]).toContain("vc link --cwd /absolute/path/to/folder");
    fireEvent.change(slot.getByLabelText("Linked folder"), {
      target: { value: "/Users/me/My App" },
    });
    expect(slot.getByText("vc link --cwd '/Users/me/My App'")).toBeTruthy();
    expect(
      slot.getByRole("button", { name: "Connect linked project" }),
    ).toBeTruthy();
  });

  it("lists only enrolled machines and connects the chosen machine and folder", async () => {
    const pending = deferred<Account>();
    const slot = renderSettings({
      "account.inspect": () => NOT_CONNECTED,
      "account.connect": () => pending.promise,
    });
    const trigger = await slot.findByRole("button", {
      name: /Machine Choose a machine/,
    });
    openMenu(trigger);
    const choices = (await slot.findAllByRole("menuitemradio")).map(
      (item) => item.textContent,
    );
    expect(choices).toEqual(["Tom's MacBook", "StudioOffline", "Build box"]);
    fireEvent.click(slot.getByRole("menuitemradio", { name: /Build box/ }));
    fireEvent.change(slot.getByLabelText("Linked folder"), {
      target: { value: "  /srv/vercel-bb  " },
    });
    fireEvent.click(
      slot.getByRole("button", { name: "Connect linked project" }),
    );
    const busy = await slot.findByRole("button", { name: "Connecting…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(connectCalls(slot)).toEqual([
      {
        method: "account.connect",
        input: {
          hostId: "host-linux",
          directory: "/srv/vercel-bb",
          adoptLegacyAllocations: false,
          expectedLegacyIdentity: null,
        },
      },
    ]);
    await act(async () => {
      pending.resolve({
        ...CONNECTED,
        hostId: "host-linux",
        directory: "/srv/vercel-bb",
      });
      await pending.promise;
    });
    expect(
      slot.getByText(
        "Connected. New sandboxes use the Vercel CLI on Build box.",
      ),
    ).toBeTruthy();
    expect(slot.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });

  it("shows the server's safe reason when connecting is refused", async () => {
    const slot = renderSettings({
      "account.inspect": () => NOT_CONNECTED,
      "account.connect": () => {
        throw safeError(
          "Link an existing Vercel project in the selected directory with vc link, then reconnect.",
        );
      },
    });
    await slot.findByText(/Not connected/);
    fireEvent.change(slot.getByLabelText("Linked folder"), {
      target: { value: "/Users/me/other" },
    });
    openMenu(slot.getByRole("button", { name: /Machine/ }));
    fireEvent.click(
      await slot.findByRole("menuitemradio", { name: /Tom's MacBook/ }),
    );
    fireEvent.click(
      slot.getByRole("button", { name: "Connect linked project" }),
    );
    const alert = await slot.findByText(/Couldn't connect/);
    expect(alert.textContent).toContain(
      "Link an existing Vercel project in the selected directory with vc link",
    );
  });

  it("replaces a failed connect call with generic next steps and rechecks", async () => {
    let inspects = 0;
    const slot = renderSettings({
      "account.inspect": () => {
        inspects += 1;
        return NOT_CONNECTED;
      },
      "account.connect": () => {
        throw safeError("vc stderr: Bearer eyJsecret");
      },
    });
    await slot.findByText(/Not connected/);
    openMenu(slot.getByRole("button", { name: /Machine/ }));
    fireEvent.click(
      await slot.findByRole("menuitemradio", { name: /Build box/ }),
    );
    fireEvent.change(slot.getByLabelText("Linked folder"), {
      target: { value: "/Users/me/app" },
    });
    fireEvent.click(
      slot.getByRole("button", { name: "Connect linked project" }),
    );
    const alert = await slot.findByText(/Couldn't connect/);
    expect(alert.textContent).toContain(
      "vc login and vc link finished there as the OS user that runs BB",
    );
    await waitFor(() => expect(inspects).toBe(2));
    await slot.findByText(/Not connected/);
    expect(slot.getByText(/Couldn't connect/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(TOKEN_SHAPED);
    expect(
      slot.getByRole("button", { name: /Machine Build box/ }),
    ).toBeTruthy();
    expect(
      (slot.getByLabelText("Linked folder") as HTMLInputElement).value,
    ).toBe("/Users/me/app");
    expect(
      slot
        .getByRole("button", { name: "Connect linked project" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  function describedText(element: Element) {
    return (element.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  }

  function recordFocus() {
    const seen: {
      element: Element;
      invalid: string | null;
      described: string;
    }[] = [];
    const listener = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return;
      seen.push({
        element: event.target,
        invalid: event.target.getAttribute("aria-invalid"),
        described: describedText(event.target),
      });
    };
    document.addEventListener("focusin", listener);
    onTestFinished(() => document.removeEventListener("focusin", listener));
    return seen;
  }

  function submitConnect(slot: ReturnType<typeof renderSettings>) {
    fireEvent.submit(
      slot.getByRole("form", { name: "Connect the Vercel CLI" }),
    );
  }

  it("focuses the machine picker with its problem already described on the first blocked submit", async () => {
    const slot = renderSettings({
      "account.inspect": () => NOT_CONNECTED,
      "account.connect": () => CONNECTED,
    });
    await slot.findByText(/Not connected/);
    const seen = recordFocus();
    submitConnect(slot);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    const trigger = slot.getByRole("button", { name: /Machine/ });
    expect(seen[0]?.element).toBe(trigger);
    expect(seen[0]?.described).toContain(
      "Choose the machine where you ran vc login and vc link.",
    );
    expect(connectCalls(slot)).toEqual([]);
  });

  it("focuses an invalid folder with its error already attached on the first blocked submit", async () => {
    const slot = renderSettings({
      "account.inspect": () => NOT_CONNECTED,
      "account.connect": () => CONNECTED,
    });
    await slot.findByText(/Not connected/);
    openMenu(slot.getByRole("button", { name: /Machine/ }));
    fireEvent.click(
      await slot.findByRole("menuitemradio", { name: /Build box/ }),
    );
    const folder = slot.getByLabelText("Linked folder");
    fireEvent.change(folder, { target: { value: "projects/app" } });
    const seen = recordFocus();
    submitConnect(slot);
    await waitFor(() =>
      expect(seen.some((entry) => entry.element === folder)).toBe(true),
    );
    const first = seen.find((entry) => entry.element === folder);
    expect(first?.invalid).toBe("true");
    expect(first?.described).toContain("Use an absolute path");
    expect(connectCalls(slot)).toEqual([]);
  });

  it("focuses an offline machine with the offline reason described", async () => {
    const slot = renderSettings({
      "account.inspect": () => NOT_CONNECTED,
      "account.connect": () => CONNECTED,
    });
    await slot.findByText(/Not connected/);
    fireEvent.change(slot.getByLabelText("Linked folder"), {
      target: { value: "/Users/me/app" },
    });
    openMenu(slot.getByRole("button", { name: /Machine/ }));
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /Studio/ }));
    const seen = recordFocus();
    submitConnect(slot);
    const trigger = slot.getByRole("button", { name: /Machine Studio/ });
    await waitFor(() =>
      expect(seen.some((entry) => entry.element === trigger)).toBe(true),
    );
    expect(
      seen.find((entry) => entry.element === trigger)?.described,
    ).toContain("Studio is offline");
    expect(connectCalls(slot)).toEqual([]);
  });

  it("reports a broken pinned connection and re-checks without reconnecting", async () => {
    const first = deferred<Account>();
    let calls = 0;
    let hostLists = 0;
    const slot = renderSettings(
      {
        "account.inspect": () => {
          calls += 1;
          return calls === 1 ? first.promise : CONNECTED;
        },
      },
      () => {
        hostLists += 1;
        return HOSTS;
      },
    );
    expect(slot.getByText("Checking the Vercel connection…")).toBeTruthy();
    expect(
      slot
        .getByRole("button", { name: "Check again" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => {
      first.resolve({
        ...CONNECTED,
        available: false,
        message:
          "The Vercel CLI on this machine is signed in as a different user. Sign in again or reconnect.",
      });
      await first.promise;
    });
    const alert = slot.getByRole("alert");
    expect(alert.textContent).toContain("signed in as a different user");
    expect(
      slot.getByText("Linked folder", { selector: "dt" }).closest("dl")
        ?.textContent,
    ).toContain("prj_def");
    fireEvent.click(slot.getByRole("button", { name: "Check again" }));
    await slot.findByText(
      "Connected. New sandboxes use the Vercel CLI on Tom's MacBook.",
    );
    expect(calls).toBe(2);
    expect(hostLists).toBe(2);
    expect(connectCalls(slot)).toEqual([]);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("keeps a connect result when an older check lands afterwards", async () => {
    const recheck = deferred<Account>();
    let calls = 0;
    const slot = renderSettings({
      "account.inspect": () => {
        calls += 1;
        return calls === 1 ? NOT_CONNECTED : recheck.promise;
      },
      "account.connect": () => CONNECTED,
    });
    await slot.findByText(/Not connected/);
    fireEvent.click(slot.getByRole("button", { name: "Check again" }));
    openMenu(await slot.findByRole("button", { name: /Machine/ }));
    fireEvent.click(
      await slot.findByRole("menuitemradio", { name: /Tom's MacBook/ }),
    );
    fireEvent.change(slot.getByLabelText("Linked folder"), {
      target: { value: "/Users/me/vercel-bb" },
    });
    fireEvent.click(
      slot.getByRole("button", { name: "Connect linked project" }),
    );
    await slot.findByText(/Connected. New sandboxes use/);
    await act(async () => {
      recheck.resolve(NOT_CONNECTED);
      await recheck.promise;
    });
    expect(slot.getByText(/Connected. New sandboxes use/)).toBeTruthy();
  });

  it("recovers when the machine list fails to load", async () => {
    let lists = 0;
    const slot = renderSettings(
      { "account.inspect": () => NOT_CONNECTED },
      () => {
        lists += 1;
        if (lists === 1) throw new Error("offline");
        return HOSTS;
      },
    );
    await slot.findByText("Couldn't load your machines.");
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await slot.findByRole("button", { name: /Machine Choose a machine/ });
  });

  it("keeps earlier unbound sandboxes unmanaged until the user explicitly opts in", async () => {
    const adopt = deferred<Account>();
    const slot = renderSettings({
      "account.inspect": () => ({ ...CONNECTED, legacyAllocations: LEGACY }),
      "account.connect": () => adopt.promise,
    });
    await slot.findByRole("heading", { name: "Earlier sandboxes" });
    expect(
      slot.getByText(/BB recorded 2 earlier sandboxes in/).textContent,
    ).toContain("team_abc / prj_def");
    const consent = slot.getByRole("checkbox", {
      name: "Let tom (user_abc) on Tom's MacBook manage and clean up these 2 earlier sandboxes",
    });
    expect(consent.getAttribute("aria-checked")).toBe("false");
    const describedBy = consent.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toContain(
      "not a record of who created them",
    );
    const apply = slot.getByRole("button", {
      name: "Use this account for 2 earlier sandboxes",
    });
    expect(apply.hasAttribute("disabled")).toBe(true);
    fireEvent.click(apply);
    fireEvent.click(slot.getByRole("button", { name: "Reconnect" }));
    await slot.findByRole("button", { name: "Connecting…" });
    expect(connectCalls(slot).map((call) => call.input)).toEqual([
      {
        hostId: "host-mac",
        directory: "/Users/me/vercel-bb",
        adoptLegacyAllocations: false,
        expectedLegacyIdentity: null,
      },
    ]);
    await act(async () => {
      adopt.resolve({ ...CONNECTED, legacyAllocations: LEGACY });
      await adopt.promise;
    });
    expect(
      slot
        .getByRole("checkbox", { name: /manage and clean up/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("binds earlier sandboxes to the verified account only after consent", async () => {
    const slot = renderSettings({
      "account.inspect": () => ({ ...CONNECTED, legacyAllocations: LEGACY }),
      "account.connect": () => ({ ...CONNECTED, adoptedAllocations: 2 }),
    });
    fireEvent.click(
      await slot.findByRole("checkbox", { name: /manage and clean up/ }),
    );
    fireEvent.click(
      slot.getByRole("button", {
        name: "Use this account for 2 earlier sandboxes",
      }),
    );
    await slot.findByText(
      "BB now manages 2 earlier sandboxes with tom (user_abc).",
    );
    expect(connectCalls(slot).map((call) => call.input)).toEqual([
      {
        hostId: "host-mac",
        directory: "/Users/me/vercel-bb",
        adoptLegacyAllocations: true,
        expectedLegacyIdentity: {
          accountId: "user_abc",
          teamId: "team_abc",
          projectId: "prj_def",
          count: 2,
        },
      },
    ]);
    expect(slot.queryByRole("checkbox")).toBeNull();
  });

  it("drops consent and old notes when the connection changes to another account", async () => {
    let inspects = 0;
    const slot = renderSettings({
      "account.inspect": () => {
        inspects += 1;
        return { ...CONNECTED, legacyAllocations: LEGACY };
      },
      "account.connect": (input: { adoptLegacyAllocations: boolean }) => {
        if (input.adoptLegacyAllocations) throw safeError("Interrupted.");
        return {
          ...CONNECTED,
          accountId: "user_other",
          accountName: "sam",
          legacyAllocations: LEGACY,
        };
      },
    });
    fireEvent.click(
      await slot.findByRole("checkbox", { name: /manage and clean up/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: /Use this account/ }));
    await slot.findByText(/Some may already use this account/);
    await waitFor(() => expect(inspects).toBe(2));
    fireEvent.click(
      await slot.findByRole("checkbox", { name: /Let tom \(user_abc\)/ }),
    );
    expect(
      slot
        .getByRole("checkbox", { name: /Let tom \(user_abc\)/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Reconnect" }));
    const consent = await slot.findByRole("checkbox", {
      name: /Let sam \(user_other\) on Tom's MacBook/,
    });
    expect(consent.getAttribute("aria-checked")).toBe("false");
    expect(slot.queryByText(/Some may already use this account/)).toBeNull();
    expect(
      slot
        .getByRole("button", { name: /Use this account/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("disables adoption while the connection is broken", async () => {
    const slot = renderSettings({
      "account.inspect": () => ({
        ...CONNECTED,
        available: false,
        message: "Couldn't get a short-lived token for the linked project.",
        legacyAllocations: LEGACY,
      }),
    });
    const disabled = await slot.findByRole("checkbox", {
      name: /manage and clean up/,
    });
    expect(disabled.hasAttribute("disabled")).toBe(true);
    expect(slot.getByText(/Fix the connection above/)).toBeTruthy();
  });

  it("rechecks after a partial adoption and offers only the remaining count", async () => {
    const recheck = deferred<Account>();
    let inspects = 0;
    const slot = renderSettings({
      "account.inspect": () => {
        inspects += 1;
        return inspects === 1
          ? { ...CONNECTED, legacyAllocations: LEGACY }
          : recheck.promise;
      },
      "account.connect": () => {
        throw safeError(
          "CLI migration was interrupted after 1 confirmed allocation bindings. The default connection was not changed.",
        );
      },
    });
    fireEvent.click(
      await slot.findByRole("checkbox", { name: /manage and clean up/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: /Use this account/ }));
    await slot.findByText(/Some may already use this account/);
    expect(inspects).toBe(2);
    expect(
      slot.getByText("Checking which earlier sandboxes still need an account…"),
    ).toBeTruthy();
    expect(slot.queryByRole("checkbox")).toBeNull();
    expect(slot.queryByRole("button", { name: /Use this account/ })).toBeNull();
    expect(slot.queryByText(/BB recorded/)).toBeNull();
    await act(async () => {
      recheck.resolve({
        ...CONNECTED,
        legacyAllocations: { ...LEGACY, count: 1 },
      });
      await recheck.promise;
    });
    expect(slot.getByText(/Some may already use this account/)).toBeTruthy();
    expect(slot.getByText(/BB recorded 1 earlier sandbox in/)).toBeTruthy();
    const consent = slot.getByRole("checkbox", {
      name: "Let tom (user_abc) on Tom's MacBook manage and clean up these 1 earlier sandbox",
    });
    expect(consent.getAttribute("aria-checked")).toBe("false");
    expect(
      slot
        .getByRole("button", { name: "Use this account for 1 earlier sandbox" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      slot.getByText(/CLI migration was interrupted after 1 confirmed/),
    ).toBeTruthy();
  });

  it("offers no retry when the recheck after a failed adoption fails", async () => {
    let inspects = 0;
    const slot = renderSettings({
      "account.inspect": () => {
        inspects += 1;
        if (inspects === 1) return { ...CONNECTED, legacyAllocations: LEGACY };
        throw new Error("offline");
      },
      "account.connect": () => {
        throw new Error("interrupted");
      },
    });
    fireEvent.click(
      await slot.findByRole("checkbox", { name: /manage and clean up/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: /Use this account/ }));
    await slot.findByText(
      /Couldn't check which earlier sandboxes still need an account/,
    );
    expect(slot.getByText(/Some may already use this account/)).toBeTruthy();
    expect(slot.queryByRole("checkbox")).toBeNull();
    expect(slot.queryByText(/BB recorded/)).toBeNull();
  });

  it("replaces RPC failures with generic copy", async () => {
    const slot = renderSettings({
      "account.inspect": () => {
        throw new Error("raw vendor body with token xyz");
      },
      "launch.options": () => {
        throw new Error("raw");
      },
    });
    await slot.findByText(/Couldn't check the Vercel connection/);
    await slot.findByText("Couldn't load launch defaults.");
    expect(slot.queryByText(/xyz/)).toBeNull();
  });
});

describe("expiry indicator", () => {
  function headerSlot() {
    const action = app.threadHeaderActions[0];
    if (action === undefined) throw new Error("header action not registered");
    return action;
  }

  function sdkFor(
    machineProviderId: string | null,
    phase = "active",
    teardown: { status: string } | null = null,
    hostsGet?: () => unknown,
  ) {
    return {
      threads: {
        get: () => ({ id: "thread-1", environmentId: "env-1" }),
      },
      environments: { get: () => ({ id: "env-1", hostId: "host-1" }) },
      hosts: {
        get:
          hostsGet ??
          (() => ({
            id: "host-1",
            machineProviderId,
            lifecycle: { phase, teardown },
          })),
      },
    };
  }

  function machine(overrides: Record<string, unknown>, summary = "running") {
    return {
      summary,
      values: {
        state: "running",
        sandboxName: "bb-host-1",
        sessionId: "sbx_1",
        expiresAt: null,
        computeEnded: false,
        vcpus: 2,
        memoryMiB: 4096,
        image: LAUNCH_OPTIONS.image,
        teamId: "team_a",
        projectId: "prj_b",
        ...overrides,
      },
    };
  }

  const props = {
    threadId: "thread-1",
    projectId: "project-1",
    isCompactViewport: false,
  };

  it("renders nothing for threads on other machines", async () => {
    const inspect = vi.fn();
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(null) as never,
      rpc: { "machine.inspect": inspect },
    });
    await waitFor(() => {
      expect(slot.inspection.sdkCalls.map((call) => call.method)).toContain(
        "hosts.get",
      );
    });
    expect(slot.container.textContent).toBe("");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("renders nothing while the thread has no environment", async () => {
    const slot = renderSlot(headerSlot(), props, {
      sdk: {
        threads: { get: () => ({ id: "thread-1", environmentId: null }) },
      } as never,
    });
    await waitFor(() => {
      expect(slot.inspection.sdkCalls.map((call) => call.method)).toEqual([
        "threads.get",
      ]);
    });
    expect(slot.container.textContent).toBe("");
  });

  it("counts down and warns inside the last ten minutes", async () => {
    const now = Date.now();
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: {
        "machine.inspect": () =>
          machine({ expiresAt: now + 25 * 60_000 + 5_000 }),
      },
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: 25 minutes left",
    });
    expect(trigger.textContent).toBe("25m left");
    expect(trigger.className).not.toContain("text-warning-text");
    openMenu(trigger);
    await slot.findByText(/Stops at .*BB can't extend, pause, or save it/);
    expect(slot.getByText("2 vCPU · 4 GiB")).toBeTruthy();
  });

  it("uses warning tone near expiry and an icon-only compact trigger", async () => {
    const slot = renderSlot(
      headerSlot(),
      { ...props, isCompactViewport: true },
      {
        sdk: sdkFor(PROVIDER_ID) as never,
        rpc: {
          "machine.inspect": () =>
            machine({ expiresAt: Date.now() + 4 * 60_000 + 5_000 }),
        },
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: 4 minutes left",
    });
    expect(trigger.textContent).toBe("");
    expect(trigger.className).toContain("text-warning-text");
  });

  it("claims a stop and file loss only when Vercel observed the session stopped", async () => {
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: {
        "machine.inspect": () =>
          machine({ state: "stopped", computeEnded: true }),
      },
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: stopped",
    });
    openMenu(trigger);
    await slot.findByText(/files can't be recovered/);
    expect(slot.queryByRole("button", { name: /Refresh|Retry/ })).toBeNull();
  });

  it.each(["stopped", "failed", "aborted"])(
    "keeps a %s report without computeEnded unconfirmed and refreshable",
    async (state) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const inspect = vi.fn(() =>
        machine({ state, expiresAt: Date.now() + 60 * 60_000 }),
      );
      const slot = renderSlot(headerSlot(), props, {
        sdk: sdkFor(PROVIDER_ID) as never,
        rpc: { "machine.inspect": inspect },
      });
      const trigger = await slot.findByRole("button", {
        name: `Vercel sandbox: Vercel reports ${state}, stop unconfirmed`,
      });
      expect(trigger.textContent).toBe(
        `${state.charAt(0).toUpperCase()}${state.slice(1)}?`,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(inspect).toHaveBeenCalledTimes(1);
      openMenu(trigger);
      await slot.findByText(/hasn't confirmed it stopped/);
      expect(slot.queryByText(/can't be recovered|files are gone/)).toBeNull();
      expect(slot.getByRole("button", { name: "Refresh" })).toBeTruthy();
    },
  );

  it("never treats repeated missing reads as a confirmed stop", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inspect = vi.fn(() =>
      machine(
        { state: "missing", expiresAt: Date.now() + 60 * 60_000 },
        "Compute termination unresolved; retry cleanup after checking the Vercel dashboard.",
      ),
    );
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: { "machine.inspect": inspect },
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: status unknown",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(inspect).toHaveBeenCalledTimes(1);
    openMenu(trigger);
    await slot.findByText(/It may still be running/);
    expect(slot.getByText(/Compute termination unresolved/)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(inspect.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    expect(
      slot.getByRole("button", {
        name: "Vercel sandbox: status unknown",
        hidden: true,
      }),
    ).toBeTruthy();
    expect(slot.queryByText(/files are gone|session has ended/)).toBeNull();
  });

  it("observes Vercel at the deadline instead of inferring a stop from the clock", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = Date.now() + 2_000;
    const inspect = vi.fn(() => machine({ expiresAt }));
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: { "machine.inspect": inspect },
    });
    await slot.findByRole("button", {
      name: "Vercel sandbox: less than a minute left",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: time limit reached, checking Vercel status",
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    openMenu(trigger);
    await slot.findByText(/hasn't reported the sandbox stopped yet/);
    expect(slot.queryByText(/can't be recovered|files are gone/)).toBeNull();
    expect(slot.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("keeps checking after the deadline until Vercel confirms the stop", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = Date.now() + 2_000;
    let reads = 0;
    const inspect = vi.fn(() => {
      reads += 1;
      return reads < 4
        ? machine({ expiresAt })
        : machine({ state: "stopped", expiresAt, computeEnded: true });
    });
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: { "machine.inspect": inspect },
    });
    await slot.findByRole("button", {
      name: "Vercel sandbox: less than a minute left",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    await slot.findByRole("button", {
      name: "Vercel sandbox: time limit reached, checking Vercel status",
    });
    for (let step = 0; step < 2; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    }
    await slot.findByRole("button", { name: "Vercel sandbox: stopped" });
    expect(inspect).toHaveBeenCalledTimes(4);
  });

  it("stops automatic checks after a bounded number and says so", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = Date.now() + 2_000;
    const inspect = vi.fn(() => machine({ expiresAt }));
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: { "machine.inspect": inspect },
    });
    await slot.findByRole("button", {
      name: "Vercel sandbox: less than a minute left",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500);
    });
    for (let step = 0; step < 12; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    }
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: time limit reached, Vercel hasn't reported a stop",
    });
    expect(inspect).toHaveBeenCalledTimes(11);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(inspect).toHaveBeenCalledTimes(11);
    openMenu(trigger);
    await slot.findByText(/Refresh to check again/);
  });

  it("retries a failed host lookup instead of hiding the indicator", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let lookups = 0;
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID, "active", null, () => {
        lookups += 1;
        if (lookups === 1) throw new Error("503");
        return {
          id: "host-1",
          machineProviderId: PROVIDER_ID,
          lifecycle: { phase: "active", teardown: null },
        };
      }) as never,
      rpc: {
        "machine.inspect": () =>
          machine({ expiresAt: Date.now() + 60 * 60_000 + 30_000 }),
      },
    });
    await waitFor(() => {
      expect(lookups).toBe(1);
    });
    expect(slot.container.textContent).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await slot.findByRole("button", { name: "Vercel sandbox: 1 hour left" });
  });

  it("reports failed cleanup as possibly still running and stops polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sdk = sdkFor(PROVIDER_ID, "removing", { status: "failed" });
    const hostsGet = vi.fn(sdk.hosts.get);
    const slot = renderSlot(headerSlot(), props, {
      sdk: { ...sdk, hosts: { get: hostsGet } } as never,
      rpc: { "machine.inspect": vi.fn() },
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: cleanup failed",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(hostsGet).toHaveBeenCalledTimes(1);
    openMenu(trigger);
    await slot.findByText(
      /may still be running and billing your team\. Retry cleanup in machine settings or with bb machine retry-cleanup host-1\./,
    );
    expect(slot.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("opens an accessible dialog that exposes the stop time and details", async () => {
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: {
        "machine.inspect": () =>
          machine({ expiresAt: Date.now() + 60 * 60_000 + 30_000 }),
      },
    });
    openMenu(
      await slot.findByRole("button", { name: "Vercel sandbox: 1 hour left" }),
    );
    const dialog = await slot.findByRole("dialog", { name: "Vercel sandbox" });
    expect(dialog.textContent).toContain("Stops at");
    expect(dialog.textContent).toContain("bb-host-1");
  });

  it("returns to the countdown when a refresh sees the session running", async () => {
    const expiresAt = Date.now() + 2 * 60 * 60_000 + 30_000;
    const inspect = vi
      .fn()
      .mockReturnValueOnce(machine({ state: "stopped", expiresAt }))
      .mockReturnValue(machine({ expiresAt }));
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: { "machine.inspect": inspect },
    });
    openMenu(
      await slot.findByRole("button", {
        name: "Vercel sandbox: Vercel reports stopped, stop unconfirmed",
      }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Refresh" }));
    await slot.findByText(/Stops at .*BB can't extend/);
    expect(
      slot.getByRole("button", {
        name: "Vercel sandbox: 2 hours left",
        hidden: true,
      }),
    ).toBeTruthy();
  });

  it("reports removal in progress without claiming it finished", async () => {
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID, "removing") as never,
      rpc: { "machine.inspect": vi.fn() },
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: being removed",
    });
    openMenu(trigger);
    await slot.findByText(/BB is removing this sandbox machine/);
    expect(slot.queryByText(/files are gone/)).toBeNull();
  });

  it("marks a destroyed machine as removed with no recovery action", async () => {
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID, "destroyed") as never,
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: removed",
    });
    openMenu(trigger);
    await slot.findByText(/BB removed this sandbox machine/);
    expect(slot.queryByRole("button", { name: /Refresh|Retry/ })).toBeNull();
  });

  it("shows starting without inspecting a machine that is still being created", async () => {
    const inspect = vi.fn();
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID, "creating") as never,
      rpc: { "machine.inspect": inspect },
    });
    await slot.findByRole("button", { name: "Vercel sandbox: starting" });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("recovers from an inspection failure with Retry", async () => {
    let calls = 0;
    const slot = renderSlot(headerSlot(), props, {
      sdk: sdkFor(PROVIDER_ID) as never,
      rpc: {
        "machine.inspect": () => {
          calls += 1;
          if (calls === 1) throw new Error("raw vendor detail");
          return machine({ expiresAt: Date.now() + 3 * 60 * 60_000 + 5_000 });
        },
      },
    });
    const trigger = await slot.findByRole("button", {
      name: "Vercel sandbox: status unavailable",
    });
    expect(slot.queryByText(/raw vendor detail/)).toBeNull();
    openMenu(trigger);
    await slot.findByText(/Stops at .*BB can't extend/);
    expect(
      slot.getByRole("button", {
        name: "Vercel sandbox: 3 hours left",
        hidden: true,
      }),
    ).toBeTruthy();
    expect(calls).toBe(2);
  });
});
