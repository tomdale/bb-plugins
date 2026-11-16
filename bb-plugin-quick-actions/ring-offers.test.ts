// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  OFFER_EVENT,
  REQUEST_EVENT,
  parseOffer,
  ringKeys,
  useActionOffers,
} from "./ring-offers";

const offer = (detail: unknown) =>
  window.dispatchEvent(new CustomEvent(OFFER_EVENT, { detail }));

/** A plugin that offers its actions on load and again on every request. */
function providePlugin(...details: unknown[]) {
  const announce = () => details.forEach(offer);
  window.addEventListener(REQUEST_EVENT, announce);
  announce();
  return () => window.removeEventListener(REQUEST_EVENT, announce);
}

const removers: (() => void)[] = [];
afterEach(() => {
  while (removers.length > 0) removers.pop()!();
});

describe("parseOffer", () => {
  it("takes a thread action key and an optional finite order", () => {
    expect(parseOffer({ key: "workstreams/snooze" })).toEqual({ key: "workstreams/snooze" });
    expect(parseOffer({ key: "workstreams/snooze", order: 200 })).toEqual({
      key: "workstreams/snooze",
      order: 200,
    });
  });

  it("rejects anything else", () => {
    for (const detail of [
      null,
      "workstreams/snooze",
      {},
      { key: "snooze" },
      { key: "a/b/c" },
      { key: "work streams/snooze" },
      { key: "workstreams/snooze", order: "200" },
      { key: "workstreams/snooze", order: Number.NaN },
    ]) {
      expect(parseOffer(detail)).toBeNull();
    }
  });
});

describe("ringKeys", () => {
  it("puts BB's actions in order, then offers without an order", () => {
    expect(ringKeys([{ key: "other/later" }])).toEqual([
      "bb--core/archive",
      "bb--core/pin",
      "bb--core/read",
      "bb--core/copyLink",
      "other/later",
    ]);
  });

  it("places ordered offers among BB's actions, ties in arrival order", () => {
    expect(
      ringKeys([
        { key: "workstreams/snooze", order: 200 },
        { key: "other/first", order: 50 },
        { key: "other/tied", order: 200 },
      ]),
    ).toEqual([
      "other/first",
      "bb--core/archive",
      "workstreams/snooze",
      "other/tied",
      "bb--core/pin",
      "bb--core/read",
      "bb--core/copyLink",
    ]);
  });

  it("ignores offers of BB's own actions", () => {
    expect(ringKeys([{ key: "bb--core/pin", order: 1 }])[0]).toBe("bb--core/archive");
  });
});

describe("useActionOffers", () => {
  it("asks plugins that loaded first for their offers", () => {
    removers.push(providePlugin({ key: "workstreams/snooze", order: 200 }));
    const { result, unmount } = renderHook(() => useActionOffers());
    expect(result.current).toEqual([{ key: "workstreams/snooze", order: 200 }]);
    unmount();
  });

  it("takes offers from plugins that load later, ignoring malformed ones", () => {
    const { result, unmount } = renderHook(() => useActionOffers());
    expect(result.current).toEqual([]);
    act(() => {
      removers.push(providePlugin({ key: "later/action" }, { key: "broken" }));
    });
    expect(result.current).toEqual([{ key: "later/action" }]);
    unmount();
  });

  it("keeps one offer per key, in its first position with the latest order", () => {
    const { result, unmount } = renderHook(() => useActionOffers());
    act(() => {
      offer({ key: "a/one", order: 10 });
      offer({ key: "b/two" });
      offer({ key: "a/one", order: 30 });
    });
    expect(result.current).toEqual([{ key: "a/one", order: 30 }, { key: "b/two" }]);
    unmount();
  });

  it("forgets offers when the last menu unmounts and asks again on the next", () => {
    const first = renderHook(() => useActionOffers());
    act(() => offer({ key: "gone/action" }));
    first.unmount();
    removers.push(providePlugin({ key: "still/here" }));
    const second = renderHook(() => useActionOffers());
    expect(second.result.current).toEqual([{ key: "still/here" }]);
    second.unmount();
  });
});
