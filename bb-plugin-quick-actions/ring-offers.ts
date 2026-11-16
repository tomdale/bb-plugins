/**
 * How other plugins put their BB thread actions in the ring. A plugin offers
 * one of its registered thread actions by key in an event on `window`, and
 * Quick Actions asks for offers whenever its menu mounts. Neither side imports
 * the other, so each plugin works without the other installed.
 *
 * An offer only names an action; the action itself (label, icon, choices,
 * whether a thread has it at all) comes from BB's thread action registry, so
 * the ring shows what BB's own thread menus show.
 */
import { useSyncExternalStore } from "react";

/** Dispatched by a plugin with an `ActionOffer` as `detail`. */
export const OFFER_EVENT = "bb-quick-actions:offer";
/** Dispatched by Quick Actions; plugins answer with their offers again. */
export const REQUEST_EVENT = "bb-quick-actions:request";

export type ActionOffer = {
  /** The thread action's key, `<plugin id>/<registration id>`. */
  key: string;
  /** Position among the ring's actions; see `CORE_ACTIONS`. */
  order?: number;
};

/** BB's own actions, always offered, with the orders offers sort against. */
export const CORE_ACTIONS: readonly Required<ActionOffer>[] = [
  { key: "bb--core/archive", order: 100 },
  { key: "bb--core/pin", order: 300 },
  { key: "bb--core/read", order: 400 },
  { key: "bb--core/copyLink", order: 500 },
];
/** An offer without an order goes after BB's actions. */
const DEFAULT_ORDER = 1000;
const KEY_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/** An offer event's detail as an offer, or null when it is malformed. */
export function parseOffer(detail: unknown): ActionOffer | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { key, order } = detail as { key?: unknown; order?: unknown };
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) return null;
  if (order === undefined) return { key };
  return typeof order === "number" && Number.isFinite(order) ? { key, order } : null;
}

/**
 * The ring's thread action keys in ring order: BB's actions and the offered
 * ones sorted by order, ties in arrival order. Offers of BB's own actions are
 * ignored.
 */
export function ringKeys(offers: readonly ActionOffer[]): string[] {
  const core = new Set(CORE_ACTIONS.map((action) => action.key));
  return [
    ...CORE_ACTIONS,
    ...offers
      .filter((offer) => !core.has(offer.key))
      .map((offer) => ({ key: offer.key, order: offer.order ?? DEFAULT_ORDER })),
  ]
    .map((action, index) => ({ ...action, index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((action) => action.key);
}

let offers: readonly ActionOffer[] = [];
const listeners = new Set<() => void>();

function receive(event: Event) {
  const offer = parseOffer((event as CustomEvent<unknown>).detail);
  if (!offer) return;
  const index = offers.findIndex((current) => current.key === offer.key);
  if (index >= 0 && offers[index]!.order === offer.order) return;
  // A repeated offer keeps its arrival position and takes the new order.
  offers =
    index >= 0
      ? offers.map((current, i) => (i === index ? offer : current))
      : [...offers, offer];
  for (const listener of listeners) listener();
}

/**
 * Offers are collected only while a menu is mounted and cleared when the last
 * one unmounts; the request each first subscriber sends gathers them again.
 */
function subscribe(listener: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first) {
    window.addEventListener(OFFER_EVENT, receive);
    window.dispatchEvent(new CustomEvent(REQUEST_EVENT));
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener(OFFER_EVENT, receive);
    offers = [];
  };
}

const snapshot = () => offers;

/** The offers received so far, in arrival order. */
export function useActionOffers(): readonly ActionOffer[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
