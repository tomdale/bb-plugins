# Thread Export

Save a thread as a single HTML file that looks like bb's own chat, so someone
without bb can read it in a browser: the same message layout, rendered Markdown,
code blocks, diffs, tool rows, inline UI blocks, and theme.

## Use it

Open a thread, then choose **Share as page** from the thread panel's action
list. The panel builds the page and shows the result as a live preview; **Save
page** writes it to disk through bb's normal download path (on iOS, the share
sheet).

The file is self-contained. Fonts, stylesheets, and images are inlined, so it
opens with no network access and no bb server. Dark or light follows the theme
that was active when it was captured.

## How it works

The export renders the thread through bb's own `ThreadChat` component
(`variant: "timeline"`, `layout: "document"`) off-screen at the page's reading
width, so the snapshot is bb's real markup rather than a re-implementation of
it. It then:

1. loads older pages of the timeline until the thread is complete,
2. clones the rendered transcript and drops what only works in a running app,
3. inlines every loaded stylesheet, its fonts, and its images as data URLs,
4. wraps that in a page header naming the project and capture time.

`lib/snapshot.ts` (inlining and sanitizing), `lib/export-document.ts` (page
assembly), `lib/transcript-stage.ts` (driving the timeline), and
`lib/capture-thread.ts` (the whole flow) are ordinary DOM code, tested with
jsdom; `components/ExportPanel.tsx` is the panel around them.

## Limits

- The page is static. Controls that need bb's React state — expandable detail
  rows, the inline UI language's inputs, lightboxes — render in their default
  state and do not respond to clicks. Native `<details>` still opens.
- Live canvas and `<video>` content is captured as an image, or left out.
- An extremely long thread stops loading after 80 pages; the panel says so when
  that happens rather than claiming the export is complete.
- The transcript is captured at a fixed 820px reading width, so a narrow panel
  previews the same page everyone else will see.
