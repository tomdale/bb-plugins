---
name: read-aloud
description:
  Configure and use the BB Read aloud plugin for speaking individual assistant
  responses.
---

# Read aloud

Use the **Read response aloud / stop playback** action on an assistant response.
An inline player appears beneath the message while speech is prepared and
played. It shows live audio levels and progress, and provides pause, resume, and
stop controls. Click or drag the waveform to seek through the whole response, or
focus it and use ArrowLeft/ArrowRight in 5% steps, Home, or End. Whole-response positions
are estimated by phrase character counts because phrase durations are not known
until audio is fetched. Phrase audio already fetched during a playback session is
cached for immediate revisits. Activating the same response action again also
stops playback. Playback continues across thread navigation; while the
inline player is not visible (another thread is open, the message is scrolled
out of view, or its timeline row is unavailable) a floating mini player shows
the thread title with pause, stop, and seek, and its title navigates back to the
message. One response plays at a time; reading another stops the current one. On BB
runtimes without the `experimental_roles` message-action filter, the action
also appears on user messages and does nothing there.

Install from the toolbelt repository root with `npm install --prefix
bb-plugin-tts` and `bb plugin install ./bb-plugin-tts`.

Set **Vercel AI Gateway API key override** in Settings → Installed plugins →
Read aloud; enter the key there rather than as a command argument, which can be
recorded in shell history. Never print the key. A non-empty plugin secret setting overrides BB environment values
for all threads. On BB runtimes that provide the environment-key accessor, you
can instead set `AI_GATEWAY_API_KEY` in Settings → Environment variables
(globally or for the project); Read aloud uses the thread's project value,
falling back to the global value. BB scope precedence means a project
value, including an empty value, overrides global. Read aloud treats an
effective empty/whitespace-only key as unconfigured and returns HTTP 503, while
a whitespace-only plugin override falls through to BB environment values. Reload
with `bb plugin reload tts` after initial global configuration so
needs-configuration status updates. Project-only keys are resolved per thread
and do not affect plugin-wide status.

The environment-key accessor is `bb.experimental_resolveAiGatewayApiKey`, a
restricted server accessor that resolves the requested thread on the server and
reads only `AI_GATEWAY_API_KEY` for that thread's project, then global scope.
The plugin detects it at runtime; BB 0.44.0 and SDK 0.5.29 do not provide it, so
on those runtimes the plugin checks the thread through `bb.sdk.threads.get` and
uses only the plugin override. `bb plugin dev ./bb-plugin-tts` rebuilds and
reloads the local path plugin.

BB's local server is single-owner. Plugin HTTP `local` auth validates
local/trusted Origin and JSON mutation content type, not per-user or per-project
membership. `requirePublicThread` proves existence and non-deletion, not
caller-specific project access. Anyone able to call this local plugin route can
request speech using any existing thread's project key. Do not expose it to
untrusted users or a public proxy. BB plugins are trusted server-side code.
Never return the key to a client or log it.

The plugin sends extracted assistant response text to Vercel AI Gateway's speech
endpoint using configurable OpenAI `tts-1` or `tts-1-hd` models, one of their
six voices `alloy`, `echo`, `fable`, `nova`, `onyx`, and `shimmer`, and speed
from 0.25 to 4. The plugin requests MP3 output and passes the configured
speed. Defaults are `openai/tts-1`,
`alloy`, and speed 1. Configure settings under Settings → Installed plugins →
Read aloud, with `bb plugin config tts` or
`bb plugin config tts set model openai/tts-1-hd`,
`bb plugin config tts set voice nova`,
`bb plugin config tts set speed 1.25`. SDK clients can call
`bb.sdk.plugins.updateSettings({ pluginId: "tts", values: { model: "openai/tts-1-hd", voice: "nova", speed: 1.25 } })`.
The plugin excludes separate tool-output cards, reads Markdown as prose, limits
text to 4,000 characters, and limits each phrase request to 360 characters. The
Gateway returns complete base64 audio JSON; its documented REST endpoint does
not stream audio. Read aloud starts after the first phrase is synthesized and
fetches a following phrase ahead while playback runs, which can reduce perceived
latency and gaps but cannot stream within a phrase. Cached phrase audio is
released on stop, completion, errors, and teardown. Hovering over the player
shows the measured time to first playback. Speech requires an available Gateway
account/model. Gateway errors appear in the player. The server disables HTTP caching; phrase
audio is cached in memory only for the playback session.
