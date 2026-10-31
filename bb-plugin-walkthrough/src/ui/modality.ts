// Tracks whether the last thing the person did was point or press a key, as a
// flag on <html> that app.css reads. Browsers show :focus-visible on an element
// that script focuses when the previously focused element showed it, which
// includes a dialog's button opened from a menu item the pointer chose. The
// plugin cannot know that from CSS, so it records the input itself.
const POINTER_FLAG = "data-wt-pointer";
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

let installed = false;

/** Install the document listeners once; safe to call from every module that needs the flag. */
export function trackInputModality(doc: Document = document): void {
  if (installed) return;
  installed = true;
  const root = doc.documentElement;
  doc.addEventListener("pointerdown", () => root.setAttribute(POINTER_FLAG, ""), true);
  doc.addEventListener(
    "keydown",
    (event) => {
      if (!MODIFIERS.has(event.key)) root.removeAttribute(POINTER_FLAG);
    },
    true,
  );
}

if (typeof document !== "undefined") trackInputModality();
