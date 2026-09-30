# Read aloud

Read aloud adds an action to each assistant response in the chat timeline.
Choose **Read response aloud / stop playback** to open the inline player beneath
that response and request speech. The player shows preparation, live audio
levels with playback progress, pause/resume, and stop controls. Click or drag the
waveform to seek, or focus it and use Left/Right (5% steps), Home, and End. The
whole-response timeline estimates phrase lengths from their character counts;
seeking within a phrase maps the estimated position to that phrase's audio offset.
Fetched phrase audio is cached for the playback session so revisiting a phrase
is immediate. Playback
continues when you navigate to another thread or scroll the message out of
view; a floating mini player then shows the thread being read with pause,
stop, and seek controls, and clicking the thread title returns to the message.
The inline player reappears beneath the message when its thread is open again.
One response plays at a time: reading another response stops the current one.
Clicking the action for the active response again also stops it. It reads assistant text
only—not tool output or hidden execution data. BB runtimes that support the
`experimental_roles` message-action filter show the action only on assistant
messages; on other runtimes the action also appears on user messages and does
nothing there. When the timeline does not expose the message's rendered row, only the mini
player is shown.

## Setup

1. From the toolbelt repository root, install dependencies with
   `npm install --prefix bb-plugin-tts`, then install the plugin with
   `bb plugin install ./bb-plugin-tts`.
2. Set **Vercel AI Gateway API key override** in Settings → Installed plugins →
   Read aloud. Enter it there rather than as a CLI argument, which can be
   recorded in shell history. A non-empty plugin secret setting takes precedence over BB environment values for every
   thread.
3. On BB runtimes that provide the environment-key accessor (see below), you can
   instead set `AI_GATEWAY_API_KEY` in Settings → Environment variables,
   globally or in the relevant project's Advanced settings. Read aloud resolves
   the request's explicit thread and uses its project value, falling back to the
   global value. Clear the plugin override to use the scoped BB environment
   value.
4. Reload with `bb plugin reload tts` after initial configuration so plugin
   status reflects the key.
5. For a dev loop, run `bb plugin dev ./bb-plugin-tts`; it rebuilds the
   frontend and backend and reloads the installed path plugin.
6. Open a thread and use an assistant message's action button (or its mobile
   overflow menu).

BB's current local server is single-owner: plugin HTTP `local` auth checks
trusted/local Origin and requires JSON on mutations; it does not provide
per-user or per-project authorization. `requirePublicThread` confirms the thread
exists and is not deleted; it does not establish caller-specific project access.
This plugin uses that model, so anyone able to call the authenticated local
plugin route can request speech using any existing thread's project key. Do not
expose this route through a public proxy or to mutually untrusted users. BB
plugins are trusted server-side code. This plugin's experimental accessor is
restricted to the `tts` plugin and the single `AI_GATEWAY_API_KEY` variable;
thread scope is resolved server-side, never inferred from a caller-supplied
project id. The effective environment value is used only to authorize a speech
request and is never returned in an HTTP response or written to plugin logs. A
project override applies only to threads in that project; otherwise the global
value is used. BB machine environment follows its normal scope rule: a project
variable, including an empty value, overrides global scope. Read aloud treats an
effective empty/whitespace-only value as unconfigured rather than falling back
to a less-specific key, and returns HTTP 503 for speech. A whitespace-only
plugin setting is treated as absent and falls through to BB environment
configuration. With no effective key, speech requests return HTTP 503 and the
plugin reports needs-configuration when no global environment key or override
exists. Project-only keys are checked per request and do not change plugin-wide
status.

The environment-key accessor is `bb.experimental_resolveAiGatewayApiKey`, and
the plugin detects it at runtime. BB 0.44.0 and SDK 0.5.29 do not provide it; on
those runtimes the plugin validates the thread through `bb.sdk.threads.get`,
uses only the plugin key override, and its status asks for that override. The
manifest's SDK floor does not indicate whether the accessor exists.

The plugin uses Vercel AI Gateway's versioned speech-model endpoint
`https://ai-gateway.vercel.sh/v4/ai/speech-model` with configurable OpenAI
`tts-1`/`tts-1-hd` models, their six supported voices (`alloy`, `echo`, `fable`,
`nova`, `onyx`, `shimmer`), and speaking speed from 0.25 to 4. MP3 output stays
fixed for browser playback. Defaults preserve `openai/tts-1`, `alloy`, and speed

1. Gateway speech documentation also lists Google Gemini 3.8 TTS, which returns
   WAV by default and does not support numeric speed; those models are excluded
   because the current player requires MP3. The Gateway returns complete
   base64-encoded audio in JSON; its REST speech API does not support streaming
   output. The plugin splits prose into short phrase requests, starts playback when
   the first phrase is ready, and prefetches the next phrase during playback. This
   reduces the initial synthesis workload and hides some later request time, but does
   not make a phrase itself stream. Hovering over the player shows the elapsed time
   from activation to first playback. Gateway model/voice availability and account
   entitlements are controlled by Vercel; an unavailable model appears as a bounded
   error in the player. Configure settings in Settings → Installed plugins →
   Read aloud, or from the CLI: `bb plugin config tts` shows settings,
   `bb plugin config tts set model openai/tts-1-hd`,
   `bb plugin config tts set voice nova`, and
   `bb plugin config tts set speed 1.25`. The SDK equivalent is
   `bb.sdk.plugins.updateSettings({ pluginId: "tts", values: { model: "openai/tts-1-hd", voice: "nova", speed: 1.25 } })`.
   The server bounds requests to 4,000 extracted characters and decoded audio to
   10 MiB, disables caching, and sends no credentials to the client. Generated
   speech text and audio are sent to Vercel AI Gateway.

Markdown is reduced to readable prose, including headings, links, inline/fenced
code, lists, quotes and tables. The response text action doesn't include tool
cards and related non-conversation output. Audio is requested only on activation
and uses revocable in-memory object URLs; stopping, completion, errors, and
component teardown cancel outstanding requests and release playback resources,
including cached phrase audio.
