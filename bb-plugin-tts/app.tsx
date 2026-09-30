import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ThreadTitle,
  definePluginApp,
  useBbContext,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { ThreadChatMessageReference } from "@get-bb/plugin-sdk/app";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { extractSpeechText } from "./tts.js";

const MAX_ERROR_LENGTH = 240;
const MAX_CHUNK_CHARACTERS = 360;
const playListeners = new Set<(message: ThreadChatMessageReference) => void>();

type SpeechSegment = { blob: Blob; url: string };
type ActivePlayback = {
  messageId: string;
  controller: AbortController;
  audio: HTMLAudioElement | null;
  urls: Set<string>;
  segments: string[];
  prefetched: Promise<SpeechSegment> | null;
  segmentCache: Map<number, SpeechSegment>;
  segmentRequests: Map<number, Promise<SpeechSegment>>;
  seekVersion: number;
  currentIndex: number;
  progressTimer: number | null;
  isPlaying: boolean;
  seek: ((progress: number) => void) | null;
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  source: MediaElementAudioSourceNode | null;
  startedAt: number;
};
type PlaybackView = {
  messageId: string;
  state: "loading" | "playing" | "paused";
  progress: number;
  firstAudioMs: number | null;
};

export function splitSpeechText(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(?:[”’\"]+)?|[^.!?]+$/g) ?? [text];
  const segments: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (const word of words) {
      if (word.length > MAX_CHUNK_CHARACTERS) {
        if (current) segments.push(current);
        current = "";
        for (
          let offset = 0;
          offset < word.length;
          offset += MAX_CHUNK_CHARACTERS
        ) {
          segments.push(word.slice(offset, offset + MAX_CHUNK_CHARACTERS));
        }
        continue;
      }
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > MAX_CHUNK_CHARACTERS && current) {
        segments.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
  }
  if (current) segments.push(current);
  return segments;
}

export function requestReadAloud(message: ThreadChatMessageReference): void {
  for (const listener of playListeners) listener(message);
}

function errorFromResponse(response: Response): Promise<string> {
  return response
    .json()
    .then((body: unknown) => {
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
      ) {
        return body.error.slice(0, MAX_ERROR_LENGTH);
      }
      return `Speech request failed (${response.status}).`;
    })
    .catch(() => `Speech request failed (${response.status}).`);
}

type WaveState = PlaybackView["state"] | "closing";

const CLIP_CENTER = "inset(0 50% 0 50%)";
const CLIP_FULL = "inset(0 0% 0 0%)";
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";

function springEasing(bounce: number): string {
  const damping = 1 - bounce;
  const frequency = 6.9 / damping;
  const damped = frequency * Math.sqrt(1 - damping * damping);
  const points: string[] = [];
  for (let step = 0; step <= 48; step += 1) {
    const time = step / 48;
    const decay = Math.exp(-damping * frequency * time);
    const value =
      step === 48
        ? 1
        : 1 -
          decay *
            (Math.cos(damped * time) +
              ((damping * frequency) / damped) * Math.sin(damped * time));
    points.push(value.toFixed(4));
  }
  return `linear(${points.join(", ")})`;
}

function springOrFallback(bounce: number): string {
  return typeof CSS !== "undefined" &&
    CSS.supports("transition-timing-function", "linear(0, 1)")
    ? springEasing(bounce)
    : EASE_OUT;
}

function canAnimate(element: HTMLElement | null): element is HTMLElement {
  return element !== null && typeof element.animate === "function";
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function Waveform({
  analyser,
  progress,
  state,
  onSeek,
}: {
  analyser: AnalyserNode | null;
  progress: number;
  state: WaveState;
  onSeek: (progress: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const progressRef = useRef(progress);
  const stateRef = useRef(state);
  const hoverRef = useRef<number | null>(null);
  const dragRef = useRef<number | null>(null);
  useEffect(() => {
    progressRef.current = progress;
    stateRef.current = state;
  }, [progress, state]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const samples = analyser
      ? new Uint8Array(analyser.frequencyBinCount)
      : null;
    const style = getComputedStyle(canvas);
    const player = canvas.closest<HTMLElement>(".tts-player, .tts-mini");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const barWidth = 2;
    const gap = 2.5;
    const introStart = performance.now();
    let levels: number[] = [];
    let animation = 0;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * ratio);
      canvas.height = Math.round(canvas.clientHeight * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      levels = Array.from(
        {
          length: Math.max(
            1,
            Math.floor((canvas.clientWidth + gap) / (barWidth + gap)),
          ),
        },
        () => 0,
      );
    };
    resize();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    const draw = (time: number) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const bars = levels.length;
      const still = reducedMotion.matches;
      const current = stateRef.current;
      const playing = current === "playing";
      if (samples && playing) analyser?.getByteFrequencyData(samples);
      context.clearRect(0, 0, width, height);
      const ink = style.color;
      const played = Math.round((progressRef.current / 100) * bars);
      const front = (time - introStart - 240) / 700;
      let total = 0;
      for (let index = 0; index < bars; index += 1) {
        const mirrored = Math.abs(index - (bars - 1) / 2) / (bars / 2);
        let target = 0;
        if (current === "loading") {
          target = still
            ? 0
            : Math.max(0, Math.sin(time / 300 - mirrored * 6)) ** 6 * 0.3;
        } else if (samples && playing) {
          const bin = Math.floor(mirrored * samples.length * 0.45);
          target = ((samples[bin] ?? 0) / 255) ** 1.4;
        }
        if (!still && current !== "closing" && front > -0.2 && front < 1.3) {
          target = Math.max(
            target,
            Math.exp(-((mirrored - front) ** 2) / 0.004) * 0.7,
          );
        }
        const level = levels[index] ?? 0;
        const next = still ? target : level + (target - level) * 0.3;
        levels[index] = next;
        total += next;
        const barHeight = Math.max(2, next * height);
        context.fillStyle = ink;
        const hover = hoverRef.current;
        const underPointer =
          hover !== null && Math.abs(index - hover * bars) < 2;
        context.globalAlpha = underPointer ? 0.62 : index < played ? 0.9 : 0.24;
        context.beginPath();
        context.roundRect(
          index * (barWidth + gap),
          (height - barHeight) / 2,
          barWidth,
          barHeight,
          barWidth / 2,
        );
        context.fill();
      }
      context.globalAlpha = 1;
      const hover = hoverRef.current;
      if (hover !== null) {
        context.fillStyle = ink;
        context.globalAlpha = 0.5;
        context.fillRect(
          Math.max(0, Math.min(width - 1, hover * width)),
          2,
          1,
          height - 4,
        );
      }
      context.globalAlpha = 1;
      player?.style.setProperty(
        "--tts-level",
        (bars > 0 ? total / bars : 0).toFixed(3),
      );
      animation = requestAnimationFrame(draw);
    };
    animation = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animation);
      observer?.disconnect();
    };
  }, [analyser]);
  return (
    <canvas
      ref={canvasRef}
      className="tts-player__wave"
      role="slider"
      tabIndex={state === "closing" ? -1 : 0}
      aria-label="Seek in response audio"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress)}
      aria-valuetext={`${Math.round(progress)}% through response`}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = Math.max(
          0,
          Math.min(1, (event.clientX - bounds.left) / bounds.width),
        );
        hoverRef.current = position;
        if (dragRef.current === event.pointerId) onSeek(position * 100);
      }}
      onPointerLeave={() => {
        if (dragRef.current === null) hoverRef.current = null;
      }}
      onPointerDown={(event) => {
        if (state === "closing") return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = Math.max(
          0,
          Math.min(1, (event.clientX - bounds.left) / bounds.width),
        );
        dragRef.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        hoverRef.current = position;
        onSeek(position * 100);
      }}
      onPointerUp={(event) => {
        if (dragRef.current !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? Math.max(0, progress - 5)
            : event.key === "ArrowRight"
              ? Math.min(100, progress + 5)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? 100
                  : null;
        if (next === null) return;
        event.preventDefault();
        onSeek(next);
      }}
    />
  );
}

const PLAYER_STYLES = `
.tts-shell{width:min(100%,30rem);margin-inline:auto;overflow-anchor:none}
.tts-shell__inner{padding-block:1.25rem 2rem}
.tts-player{--tts-level:0;position:relative;isolation:isolate;height:2.75rem;color:var(--ink);font-size:.75rem;line-height:1}
.tts-player[data-closing]{pointer-events:none}
.tts-player__haze{position:absolute;z-index:-1;inset:-1rem -2rem;pointer-events:none;opacity:calc(.7 + var(--tts-level) * 1.6);transform:scale(calc(.97 + var(--tts-level) * .35))}
.tts-player__haze:before,.tts-player__haze:after{content:"";position:absolute;inset:0}
.tts-player__haze:before{background:radial-gradient(50% 50% at 50% 50%,color-mix(in oklab,var(--ink) 8%,transparent),transparent 100%);animation:tts-drift-a 9s ease-in-out infinite alternate}
.tts-player__haze:after{background:radial-gradient(28% 42% at 32% 50%,color-mix(in oklab,var(--ink) 6%,transparent),transparent 100%),radial-gradient(28% 42% at 68% 50%,color-mix(in oklab,var(--ink) 6%,transparent),transparent 100%);animation:tts-drift-b 12s ease-in-out infinite alternate}
.tts-player__body{display:flex;align-items:center;justify-content:center;gap:.75rem;height:100%}
.tts-player__body[data-kind=error]{animation:tts-content-in .32s ${EASE_OUT} both}
.tts-player__button{display:grid;place-items:center;flex:none;width:1.75rem;height:1.75rem;padding:0;border:0;border-radius:50%;background:transparent;color:color-mix(in oklab,var(--ink) 55%,transparent);cursor:pointer;transition:color .2s ease,background .2s ease,transform .15s ease}
.tts-player__button:hover{color:var(--ink);background:color-mix(in oklab,var(--ink) 6%,transparent)}
.tts-player__button:active{transform:scale(.9)}
.tts-player__button:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.tts-player__button:disabled{cursor:default}
.tts-player__button:disabled:hover{color:color-mix(in oklab,var(--ink) 55%,transparent);background:transparent}
.tts-player__icon{width:.8rem;height:.8rem;animation:tts-icon-in .32s cubic-bezier(.34,1.56,.64,1) both}
.tts-player__spinner{animation:tts-icon-in .32s cubic-bezier(.34,1.56,.64,1) both,tts-spin .9s linear infinite}
.tts-player__wave{flex:1;min-width:0;height:1.5rem;color:var(--ink);cursor:pointer;touch-action:none;mask-image:linear-gradient(90deg,transparent,black 16%,black 84%,transparent)}\n.tts-player__wave:focus-visible{outline:2px solid var(--ring);outline-offset:3px;border-radius:2px}
.tts-player__status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.tts-player__error{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:color-mix(in oklab,var(--ink) 72%,transparent)}
@keyframes tts-content-in{from{opacity:0;filter:blur(4px)}}
@keyframes tts-icon-in{from{opacity:0;filter:blur(3px);transform:scale(.4)}}
@keyframes tts-spin{to{rotate:360deg}}
@keyframes tts-drift-a{to{transform:translateX(3%) scale(1.06,1.18)}}
@keyframes tts-drift-b{to{transform:translateX(-4%) scale(1.1,.94)}}
@media(prefers-reduced-motion:reduce){.tts-player__body,.tts-player__icon,.tts-player__spinner,.tts-player__haze:before,.tts-player__haze:after{animation:none}.tts-player__button{transition:none}}
`;

type SpaceHandoff = {
  settle: () => void;
  release: () => void;
};

const CONTENT_BELOW_THRESHOLD_PX = 32;

let releaseActiveHandoff: (() => void) | null = null;

function releaseSpaceHandoff(): void {
  releaseActiveHandoff?.();
  releaseActiveHandoff = null;
}

function pinnedTimelineContent(
  shell: HTMLElement,
): { content: HTMLElement; sentinel: HTMLElement } | null {
  for (let element = shell.parentElement; element;) {
    const sentinel = element.nextElementSibling;
    if (
      sentinel instanceof HTMLElement &&
      sentinel.classList.contains("scroll-bottom-anchor")
    ) {
      const scrollArea = sentinel.parentElement?.parentElement;
      if (!scrollArea) return null;
      const slack = scrollArea.scrollHeight - scrollArea.clientHeight;
      return slack > 0 && slack - scrollArea.scrollTop <= 4
        ? { content: element, sentinel }
        : null;
    }
    element = element.parentElement;
  }
  return null;
}

function handOffSpace(
  shell: HTMLElement,
  timing: KeyframeAnimationOptions | null,
): SpaceHandoff | null {
  const timeline = pinnedTimelineContent(shell);
  if (!timeline) return null;
  const shellBox = shell.getBoundingClientRect();
  const contentBelow =
    timeline.content.getBoundingClientRect().bottom - shellBox.bottom;
  if (contentBelow < CONTENT_BELOW_THRESHOLD_PX) return null;
  releaseSpaceHandoff();
  const height = shellBox.height;
  const spacer = document.createElement("div");
  spacer.dataset.ttsScrollSpacer = "";
  spacer.setAttribute("aria-hidden", "true");
  spacer.style.cssText =
    "flex:none;height:0px;overflow-anchor:none;pointer-events:none";
  timeline.sentinel.before(spacer);
  const canAnimateSpacer = typeof spacer.animate === "function";
  const growth =
    timing && canAnimateSpacer
      ? spacer.animate([{ height: "0px" }, { height: `${height}px` }], {
          ...timing,
          fill: "forwards",
        })
      : null;
  let shrink: Animation | null = null;
  const release = () => {
    growth?.cancel();
    shrink?.cancel();
    spacer.remove();
    if (releaseActiveHandoff === release) releaseActiveHandoff = null;
  };
  releaseActiveHandoff = release;
  return {
    settle() {
      spacer.style.height = `${height}px`;
      growth?.cancel();
      if (!canAnimateSpacer || prefersReducedMotion()) {
        release();
        return;
      }
      shrink = spacer.animate([{ height: `${height}px` }, { height: "0px" }], {
        duration: 480,
        delay: 60,
        easing: EASE_IN_OUT,
        fill: "forwards",
      });
      void shrink.finished.then(release, () => undefined);
    },
    release,
  };
}

function usePlayerMotion(closing: boolean, onExited: () => void) {
  const shellRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hazeRef = useRef<HTMLSpanElement>(null);
  const onExitedRef = useRef(onExited);
  useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const pill = pillRef.current;
    const body = bodyRef.current;
    const haze = hazeRef.current;
    if (!canAnimate(shell) || !canAnimate(pill)) return;
    if (prefersReducedMotion()) {
      pill.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 200,
        easing: "ease-out",
      });
      return;
    }
    shell.style.overflow = "clip";
    const open = shell.animate(
      [{ height: "0px" }, { height: `${shell.offsetHeight}px` }],
      { duration: 300, easing: EASE_OUT },
    );
    void open.finished.then(
      () => shell.style.removeProperty("overflow"),
      () => undefined,
    );
    haze?.animate([{ opacity: 0, transform: "scale(0.3, 0.5)", offset: 0 }], {
      duration: 900,
      delay: 80,
      easing: EASE_OUT,
      fill: "backwards",
    });
    if (canAnimate(body)) {
      body.animate([{ clipPath: CLIP_CENTER }, { clipPath: CLIP_FULL }], {
        duration: 820,
        delay: 180,
        easing: springOrFallback(0.22),
        fill: "backwards",
      });
      body.animate(
        [
          { opacity: 0, filter: "blur(6px)" },
          { opacity: 1, filter: "blur(0px)" },
        ],
        { duration: 420, delay: 180, easing: EASE_OUT, fill: "backwards" },
      );
    }
  }, []);

  useEffect(() => {
    if (!closing) return;
    const shell = shellRef.current;
    const pill = pillRef.current;
    let cancelled = false;
    let space: SpaceHandoff | null = null;
    let finished = false;
    const finish = () => {
      if (cancelled || finished) return;
      finished = true;
      onExitedRef.current();
      space?.settle();
    };
    if (!canAnimate(shell) || !canAnimate(pill) || !shell.isConnected) {
      finish();
      return;
    }
    const animations: Animation[] = [];
    const collapse: KeyframeAnimationOptions = {
      duration: 280,
      delay: 520,
      easing: EASE_IN_OUT,
    };
    if (prefersReducedMotion()) {
      space = handOffSpace(shell, null);
      animations.push(
        pill.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 160,
          easing: "ease-in",
          fill: "forwards",
        }),
      );
    } else {
      const body = bodyRef.current;
      const haze = hazeRef.current;
      if (canAnimate(body)) {
        animations.push(
          body.animate([{ clipPath: CLIP_FULL }, { clipPath: CLIP_CENTER }], {
            duration: 380,
            delay: 120,
            easing: EASE_IN_OUT,
            fill: "forwards",
          }),
          body.animate(
            [
              { opacity: 1, filter: "blur(0px)" },
              { opacity: 0, filter: "blur(5px)" },
            ],
            { duration: 300, delay: 180, easing: "ease-in", fill: "forwards" },
          ),
        );
      }
      if (canAnimate(haze)) {
        animations.push(
          haze.animate([{ opacity: 0, transform: "scale(0.3, 0.5)" }], {
            duration: 420,
            delay: 220,
            easing: "ease-in",
            fill: "forwards",
          }),
        );
      }
      space = handOffSpace(shell, collapse);
      shell.style.overflow = "clip";
      animations.push(
        shell.animate(
          [
            { height: `${shell.getBoundingClientRect().height}px` },
            { height: "0px" },
          ],
          { ...collapse, fill: "forwards" },
        ),
      );
    }
    void Promise.all(animations.map((animation) => animation.finished)).then(
      finish,
      finish,
    );
    return () => {
      if (!finished) space?.release();
      cancelled = true;
    };
  }, [closing]);

  return { shellRef, pillRef, bodyRef, hazeRef };
}

function PlayerCard({
  active,
  error,
  analyser,
  closing,
  onPause,
  onSeek,
  onStop,
  onDismiss,
  onExited,
}: {
  active: PlaybackView | null;
  error: string;
  analyser: AnalyserNode | null;
  closing: boolean;
  onPause: () => void;
  onSeek: (progress: number) => void;
  onStop: () => void;
  onDismiss: () => void;
  onExited: () => void;
}) {
  const { shellRef, pillRef, bodyRef, hazeRef } = usePlayerMotion(
    closing,
    onExited,
  );
  const icon = {
    className: "tts-player__icon",
    viewBox: "0 0 16 16",
    fill: "currentColor",
    "aria-hidden": true,
  } as const;
  const iconKey = active?.state ?? "loading";
  return (
    <div ref={shellRef} className="tts-shell">
      <style>{PLAYER_STYLES}</style>
      <div className="tts-shell__inner">
        <section
          ref={pillRef}
          className="tts-player"
          aria-label="Read aloud player"
          data-closing={closing ? "" : undefined}
          title={
            active?.firstAudioMs == null
              ? undefined
              : `First audio in ${(active.firstAudioMs / 1000).toFixed(1)}s`
          }
        >
          <span ref={hazeRef} className="tts-player__haze" aria-hidden="true" />
          {error ? (
            <div
              ref={bodyRef}
              key="error"
              className="tts-player__body"
              data-kind="error"
            >
              <span className="tts-player__error" role="alert">
                {error}
              </span>
              <button
                className="tts-player__button"
                type="button"
                aria-label="Dismiss"
                onClick={onDismiss}
              >
                <svg
                  className="tts-player__icon"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          ) : active ? (
            <>
              <div ref={bodyRef} key="playback" className="tts-player__body">
                <button
                  className="tts-player__button"
                  type="button"
                  disabled={active.state === "loading"}
                  aria-label={
                    active.state === "paused"
                      ? "Resume reading response aloud"
                      : "Pause reading response aloud"
                  }
                  onClick={onPause}
                >
                  {active.state === "loading" ? (
                    <svg
                      key={iconKey}
                      className="tts-player__icon tts-player__spinner"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M8 2a6 6 0 1 1-6 6" />
                    </svg>
                  ) : (
                    <svg key={iconKey} {...icon}>
                      {active.state === "paused" ? (
                        <path d="M4.5 2.5v11l9-5.5z" />
                      ) : (
                        <path d="M4 2.5h2.75v11H4zm5.25 0H12v11H9.25z" />
                      )}
                    </svg>
                  )}
                </button>
                <Waveform
                  analyser={analyser}
                  progress={active.progress}
                  state={closing ? "closing" : active.state}
                  onSeek={onSeek}
                />
                <button
                  className="tts-player__button"
                  type="button"
                  aria-label="Stop reading response aloud"
                  onClick={onStop}
                >
                  <svg {...icon}>
                    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
                  </svg>
                </button>
              </div>
              <span className="tts-player__status" aria-live="polite">
                {active.state === "loading"
                  ? "Preparing audio…"
                  : active.state === "paused"
                    ? "Paused"
                    : "Reading aloud"}
              </span>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

const MINI_STYLES = `
.tts-mini{--tts-level:0;position:fixed;z-index:60;cursor:grab;touch-action:none;-webkit-app-region:no-drag;app-region:no-drag;transition:top .35s ${EASE_OUT},bottom .35s ${EASE_OUT};display:flex;align-items:center;gap:.5rem;width:min(calc(100vw - 2rem),21rem);height:2.75rem;padding:0 .5rem;border-radius:1.5rem;color:var(--ink);font-size:.75rem;line-height:1.2;background:radial-gradient(120% 160% at 50% 0%,color-mix(in oklab,var(--ink) calc(6% + var(--tts-level) * 10%),transparent),transparent 70%),color-mix(in oklab,var(--canvas) 78%,transparent);-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);box-shadow:0 10px 40px -12px color-mix(in oklab,var(--ink) 28%,transparent),inset 0 0 0 1px color-mix(in oklab,var(--ink) 7%,transparent);animation:tts-mini-in .42s ${EASE_OUT} both}
.tts-mini[data-dragging]{cursor:grabbing;user-select:none;transition:none;box-shadow:0 18px 50px -12px color-mix(in oklab,var(--ink) 38%,transparent),inset 0 0 0 1px color-mix(in oklab,var(--ink) 9%,transparent)}
.tts-mini[data-dragging] .tts-mini__open{cursor:grabbing}
.tts-mini[data-leaving]{pointer-events:none;animation:tts-mini-out .22s ease-in both}
.tts-mini__open{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:.15rem;padding:.25rem .375rem;border:0;border-radius:.5rem;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.tts-mini__open:hover .tts-mini__title{text-decoration:underline;text-decoration-color:color-mix(in oklab,var(--ink) 35%,transparent);text-underline-offset:2px}
.tts-mini__open:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
.tts-mini__title{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.tts-mini .tts-player__wave{flex:none;width:4.5rem;height:1.25rem}
@keyframes tts-mini-in{from{opacity:0;filter:blur(6px);transform:translateY(8px) scale(.94)}}
@keyframes tts-mini-out{to{opacity:0;filter:blur(4px);transform:translateY(6px) scale(.96)}}
@media(prefers-reduced-motion:reduce){.tts-mini,.tts-mini[data-leaving]{animation-name:tts-fade-in}.tts-mini[data-leaving]{animation-name:tts-fade-out}}
@keyframes tts-fade-in{from{opacity:0}}
@keyframes tts-fade-out{to{opacity:0}}
`;

const MINI_EXIT_MS = 220;
const MINI_CORNER_KEY = "bb-plugin-tts:mini-corner";
const MINI_MARGIN_PX = 16;
const COMPOSER_GAP_PX = 12;
const DRAG_THRESHOLD_PX = 4;
const MINI_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
type MiniCorner = (typeof MINI_CORNERS)[number];

function readMiniCorner(): MiniCorner {
  try {
    const stored = window.localStorage.getItem(MINI_CORNER_KEY);
    const corner = MINI_CORNERS.find((candidate) => candidate === stored);
    if (corner) return corner;
  } catch {
    return "bottom-right";
  }
  return "bottom-right";
}

function writeMiniCorner(corner: MiniCorner): void {
  try {
    window.localStorage.setItem(MINI_CORNER_KEY, corner);
  } catch {
    return;
  }
}

function composerClearance(): number {
  const footer = document.querySelector<HTMLElement>("[data-scroll-footer]");
  if (!footer) return MINI_MARGIN_PX;
  const clearance =
    window.innerHeight - footer.getBoundingClientRect().top + COMPOSER_GAP_PX;
  return clearance > MINI_MARGIN_PX && clearance < window.innerHeight / 2
    ? clearance
    : MINI_MARGIN_PX;
}

function useMiniDock(active: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [corner, setCorner] = useState<MiniCorner>(readMiniCorner);
  const [bottomOffset, setBottomOffset] = useState(MINI_MARGIN_PX);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const flipFromRef = useRef<DOMRect | null>(null);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let observedFooter: HTMLElement | null = null;
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => schedule());
    const measure = () => {
      frame = 0;
      const footer = document.querySelector<HTMLElement>(
        "[data-scroll-footer]",
      );
      if (footer !== observedFooter) {
        resize?.disconnect();
        if (footer) resize?.observe(footer);
        observedFooter = footer;
      }
      setBottomOffset(composerClearance());
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      mutations.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [active]);

  const springBack = (element: HTMLElement, from: DOMRect) => {
    element.style.removeProperty("translate");
    const to = element.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (
      typeof element.animate !== "function" ||
      prefersReducedMotion() ||
      (dx === 0 && dy === 0)
    )
      return;
    element.animate(
      [{ translate: `${dx}px ${dy}px` }, { translate: "0px 0px" }],
      { duration: 560, easing: springOrFallback(0.24) },
    );
  };

  useLayoutEffect(() => {
    const element = ref.current;
    const from = flipFromRef.current;
    flipFromRef.current = null;
    if (element && from) springBack(element, from);
  }, [corner]);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (
      event.target instanceof Element &&
      event.target.closest("canvas, button:not(.tts-mini__open)")
    )
      return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const element = ref.current;
    if (!drag || !element || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      element.setPointerCapture?.(event.pointerId);
      setDragging(true);
    }
    element.style.translate = `${dx}px ${dy}px`;
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const element = ref.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.moved || !element) return;
    element.releasePointerCapture?.(event.pointerId);
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    setDragging(false);
    const box = element.getBoundingClientRect();
    const vertical =
      box.top + box.height / 2 < window.innerHeight / 2 ? "top" : "bottom";
    const horizontal =
      box.left + box.width / 2 < window.innerWidth / 2 ? "left" : "right";
    const target: MiniCorner = `${vertical}-${horizontal}`;
    writeMiniCorner(target);
    if (target === corner) {
      springBack(element, box);
      return;
    }
    flipFromRef.current = box;
    setCorner(target);
  };

  const onClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const [vertical, horizontal] = corner.split("-");
  const style: CSSProperties = {
    [vertical === "top" ? "top" : "bottom"]:
      vertical === "top" ? MINI_MARGIN_PX : bottomOffset,
    [horizontal === "left" ? "left" : "right"]: MINI_MARGIN_PX,
    transformOrigin: `${horizontal === "left" ? "0%" : "100%"} ${
      vertical === "top" ? "0%" : "100%"
    }`,
  };
  return {
    ref,
    style,
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onClickCapture,
    },
  };
}

function MiniPlayer({
  visible,
  active,
  error,
  threadId,
  analyser,
  onPause,
  onSeek,
  onStop,
  onDismiss,
  onOpen,
}: {
  visible: boolean;
  active: PlaybackView | null;
  error: string;
  threadId: string | null;
  analyser: AnalyserNode | null;
  onPause: () => void;
  onSeek: (progress: number) => void;
  onStop: () => void;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  const present = visible && (active !== null || error !== "");
  const [mounted, setMounted] = useState(present);
  const dock = useMiniDock(mounted);
  const [leaving, setLeaving] = useState(false);
  const lastViewRef = useRef({ active, error, threadId });
  useEffect(() => {
    if (present) lastViewRef.current = { active, error, threadId };
  });
  useEffect(() => {
    if (present) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, MINI_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [present]);
  if (!mounted) return null;
  const view = present ? { active, error, threadId } : lastViewRef.current;
  const icon = {
    className: "tts-player__icon",
    viewBox: "0 0 16 16",
    fill: "currentColor",
    "aria-hidden": true,
  } as const;
  return (
    <section
      ref={dock.ref}
      className="tts-mini"
      aria-label="Read aloud mini player"
      data-leaving={leaving ? "" : undefined}
      data-dragging={dock.dragging ? "" : undefined}
      style={dock.style}
      {...dock.handlers}
    >
      <style>{PLAYER_STYLES}</style>
      <style>{MINI_STYLES}</style>
      {view.error ? (
        <>
          <span className="tts-mini__open" role="alert">
            <span className="tts-mini__title">{view.error}</span>
          </span>
          <button
            className="tts-player__button"
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <svg
              className="tts-player__icon"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </>
      ) : view.active ? (
        <>
          <button
            className="tts-player__button"
            type="button"
            disabled={view.active.state === "loading"}
            aria-label={
              view.active.state === "paused"
                ? "Resume reading response aloud"
                : "Pause reading response aloud"
            }
            onClick={onPause}
          >
            {view.active.state === "loading" ? (
              <svg
                className="tts-player__icon tts-player__spinner"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M8 2a6 6 0 1 1-6 6" />
              </svg>
            ) : (
              <svg key={view.active.state} {...icon}>
                {view.active.state === "paused" ? (
                  <path d="M4.5 2.5v11l9-5.5z" />
                ) : (
                  <path d="M4 2.5h2.75v11H4zm5.25 0H12v11H9.25z" />
                )}
              </svg>
            )}
          </button>
          <button
            className="tts-mini__open"
            type="button"
            aria-label="Go to the message being read aloud"
            onClick={onOpen}
          >
            <span className="tts-mini__title">
              {view.threadId ? <ThreadTitle threadId={view.threadId} /> : null}
            </span>
          </button>
          <Waveform
            analyser={analyser}
            progress={view.active.progress}
            state={leaving ? "closing" : view.active.state}
            onSeek={onSeek}
          />
          <button
            className="tts-player__button"
            type="button"
            aria-label="Stop reading response aloud"
            onClick={onStop}
          >
            <svg {...icon}>
              <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
            </svg>
          </button>
        </>
      ) : null}
    </section>
  );
}

function findMessageColumn(messageId: string): HTMLElement | null {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
  ).find((element) => element.dataset.timelineRowId === messageId);
  return row?.querySelector<HTMLElement>("[data-message-column]") ?? null;
}

function ReadAloudAction() {
  const pluginId = "tts";
  const activeRef = useRef<ActivePlayback | null>(null);
  const [active, setActive] = useState<PlaybackView | null>(null);
  const [error, setError] = useState("");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const portalTargetRef = useRef<HTMLElement | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [closing, setClosing] = useState(false);
  const [presentation, setPresentation] = useState(0);
  const [sessionThreadId, setSessionThreadId] = useState<string | null>(null);
  const [inlineVisible, setInlineVisible] = useState(false);
  const anchorMessageIdRef = useRef<string | null>(null);
  const revealPendingRef = useRef(false);
  const context = useBbContext();
  const navigate = useBbNavigate();

  const release = useCallback(() => {
    const playback = activeRef.current;
    if (playback === null) return;
    activeRef.current = null;
    playback.controller.abort();
    playback.audio?.pause();
    if (playback.progressTimer !== null) {
      window.clearInterval(playback.progressTimer);
      playback.progressTimer = null;
    }
    if (playback.audio !== null) {
      playback.audio.removeAttribute("src");
      playback.audio.load();
    }
    for (const url of playback.urls) URL.revokeObjectURL(url);
    playback.audioContext?.close();
    setAnalyser(null);
  }, []);

  const finishClose = useCallback(() => {
    portalTargetRef.current?.remove();
    portalTargetRef.current = null;
    anchorMessageIdRef.current = null;
    revealPendingRef.current = false;
    setSessionThreadId(null);
    setInlineVisible(false);
    setPortalTarget(null);
    setActive(null);
    setError("");
    setClosing(false);
  }, []);

  const stop = useCallback(() => {
    release();
    setClosing(true);
  }, [release]);

  const fail = useCallback(
    (messageText: string) => {
      release();
      setActive(null);
      setError(messageText);
    },
    [release],
  );

  const play = useCallback(
    async (message: ThreadChatMessageReference) => {
      const previous = activeRef.current;
      if (previous?.messageId === message.id) {
        stop();
        return;
      }
      release();
      finishClose();
      setPresentation((count) => count + 1);
      const text = extractSpeechText(message.text);
      const controller = new AbortController();
      const playback: ActivePlayback = {
        messageId: message.id,
        controller,
        audio: null,
        urls: new Set(),
        segments: splitSpeechText(text),
        prefetched: null,
        segmentCache: new Map(),
        segmentRequests: new Map(),
        seekVersion: 0,
        currentIndex: 0,
        progressTimer: null,
        isPlaying: true,
        seek: null,
        audioContext: null,
        analyser: null,
        source: null,
        startedAt: performance.now(),
      };
      activeRef.current = playback;
      try {
        const audioContext = new AudioContext();
        const frequency = audioContext.createAnalyser();
        frequency.fftSize = 128;
        frequency.connect(audioContext.destination);
        playback.audioContext = audioContext;
        playback.analyser = frequency;
        setAnalyser(frequency);
      } catch {
        playback.audioContext = null;
        playback.analyser = null;
      }
      const mount = document.createElement("div");
      mount.dataset.ttsInlinePlayer = "";
      findMessageColumn(message.id)?.append(mount);
      portalTargetRef.current = mount;
      anchorMessageIdRef.current = message.id;
      setPortalTarget(mount);
      setSessionThreadId(message.threadId);
      setInlineVisible(mount.isConnected);
      if (text.length === 0) {
        fail("This response has no readable text.");
        return;
      }
      setActive({
        messageId: message.id,
        state: "loading",
        progress: 0,
        firstAudioMs: null,
      });
      const prefetchSegment = (index: number): Promise<SpeechSegment> => {
        const pending = fetchSegment(index);
        void pending.catch(() => undefined);
        return pending;
      };
      const fetchSegment = (index: number): Promise<SpeechSegment> => {
        const cached = playback.segmentCache.get(index);
        if (cached) return Promise.resolve(cached);
        const pending = playback.segmentRequests.get(index);
        if (pending) return pending;
        const request = (async () => {
          const response = await fetch(
            `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/speech`,
            {
              method: "POST",
              signal: controller.signal,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                threadId: message.threadId,
                text: playback.segments[index],
              }),
            },
          );
          if (!response.ok) throw new Error(await errorFromResponse(response));
          const blob = await response.blob();
          if (activeRef.current !== playback || controller.signal.aborted) {
            throw new DOMException("Speech request cancelled", "AbortError");
          }
          const url = URL.createObjectURL(blob);
          const segment = { blob, url };
          playback.urls.add(url);
          playback.segmentCache.set(index, segment);
          return segment;
        })();
        playback.segmentRequests.set(index, request);
        void request
          .finally(() => playback.segmentRequests.delete(index))
          .catch(() => undefined);
        return request;
      };
      const segmentWeights = playback.segments.map((segment) => segment.length);
      const totalWeight = segmentWeights.reduce(
        (sum, weight) => sum + weight,
        0,
      );
      const progressFor = (index: number, fraction: number) =>
        ((segmentWeights
          .slice(0, index)
          .reduce((sum, weight) => sum + weight, 0) +
          (segmentWeights[index] ?? 0) * fraction) /
          totalWeight) *
        100;
      const positionFor = (progress: number) => {
        const target =
          (Math.max(0, Math.min(100, progress)) / 100) * totalWeight;
        let accumulated = 0;
        for (let index = 0; index < segmentWeights.length; index += 1) {
          const weight = segmentWeights[index] ?? 0;
          if (
            target <= accumulated + weight ||
            index === segmentWeights.length - 1
          ) {
            return {
              index,
              fraction: weight > 0 ? (target - accumulated) / weight : 0,
            };
          }
          accumulated += weight;
        }
        return { index: 0, fraction: 0 };
      };
      const playSegment = async (
        index: number,
        segment: SpeechSegment,
        offset = 0,
        version = playback.seekVersion,
      ) => {
        if (
          activeRef.current !== playback ||
          controller.signal.aborted ||
          version !== playback.seekVersion
        )
          return;
        if (playback.progressTimer !== null) {
          window.clearInterval(playback.progressTimer);
          playback.progressTimer = null;
        }
        playback.currentIndex = index;
        const previous = playback.audio;
        if (previous) {
          previous.pause();
          previous.removeAttribute("src");
          previous.load();
        }
        playback.source?.disconnect();
        playback.source = null;
        const audio = new Audio(segment.url);
        playback.audio = audio;
        const { audioContext, analyser: frequency } = playback;
        if (audioContext && frequency) {
          try {
            const source = audioContext.createMediaElementSource(audio);
            source.connect(frequency);
            playback.source = source;
          } catch {
            playback.source = null;
          }
          if (audioContext.state !== "running") void audioContext.resume();
        }
        const setProgress = () => {
          if (activeRef.current !== playback || playback.audio !== audio)
            return;
          const fraction =
            audio.duration > 0 ? audio.currentTime / audio.duration : 0;
          setActive((view) =>
            view?.messageId === message.id
              ? view
                ? {
                    ...view,
                    state: playback.isPlaying ? "playing" : "paused",
                    progress: progressFor(index, fraction),
                  }
                : view
              : view,
          );
        };
        const progressTimer = window.setInterval(setProgress, 180);
        playback.progressTimer = progressTimer;
        audio.addEventListener("timeupdate", setProgress);
        audio.addEventListener(
          "loadedmetadata",
          () => {
            if (offset > 0 && Number.isFinite(audio.duration)) {
              audio.currentTime = audio.duration * offset;
            }
            setProgress();
          },
          { once: true },
        );
        audio.addEventListener(
          "ended",
          () => {
            window.clearInterval(progressTimer);
            if (playback.progressTimer === progressTimer)
              playback.progressTimer = null;
            if (
              activeRef.current !== playback ||
              playback.audio !== audio ||
              version !== playback.seekVersion
            )
              return;
            if (index + 1 >= playback.segments.length) {
              stop();
              return;
            }
            const next = playback.prefetched;
            playback.prefetched = null;
            void (async () => {
              try {
                const ready = next ? await next : await fetchSegment(index + 1);
                if (
                  activeRef.current !== playback ||
                  playback.audio !== audio ||
                  version !== playback.seekVersion
                )
                  return;
                if (index + 2 < playback.segments.length) {
                  playback.prefetched = prefetchSegment(index + 2);
                }
                await playSegment(index + 1, ready);
              } catch (cause) {
                if (controller.signal.aborted || activeRef.current !== playback)
                  return;
                fail(
                  cause instanceof Error
                    ? cause.message
                    : "Speech generation failed.",
                );
              }
            })();
          },
          { once: true },
        );
        audio.addEventListener(
          "error",
          () => {
            window.clearInterval(progressTimer);
            if (playback.progressTimer === progressTimer)
              playback.progressTimer = null;
            if (
              activeRef.current === playback &&
              playback.audio === audio &&
              version === playback.seekVersion
            ) {
              fail("The generated audio could not be played.");
            }
          },
          { once: true },
        );
        if (Number.isFinite(audio.duration)) {
          audio.currentTime = audio.duration * offset;
        }
        playback.isPlaying = true;
        await audio.play();
        if (
          activeRef.current === playback &&
          playback.audio === audio &&
          version === playback.seekVersion
        ) {
          setActive((view) =>
            view?.messageId === message.id
              ? view
                ? {
                    ...view,
                    state: "playing",
                    firstAudioMs:
                      view.firstAudioMs ??
                      performance.now() - playback.startedAt,
                  }
                : view
              : view,
          );
        }
      };
      const initialSeekVersion = playback.seekVersion;
      playback.seek = (progress) => {
        if (playback.audioContext?.state === "suspended")
          void playback.audioContext.resume();
        const { index, fraction } = positionFor(progress);
        const current = playback.audio;
        const version = ++playback.seekVersion;
        if (
          index === playback.currentIndex &&
          current &&
          current.duration > 0
        ) {
          current.currentTime = current.duration * fraction;
          if (playback.isPlaying) void current.play();
          setActive((view) =>
            view?.messageId === message.id
              ? view
                ? {
                    ...view,
                    progress: progressFor(index, fraction),
                  }
                : view
              : view,
          );
          return;
        }
        current?.pause();
        if (playback.progressTimer !== null) {
          window.clearInterval(playback.progressTimer);
          playback.progressTimer = null;
        }
        playback.prefetched = null;
        setActive((view) =>
          view?.messageId === message.id
            ? view
              ? {
                  ...view,
                  state: "loading",
                  progress: progressFor(index, fraction),
                }
              : view
            : view,
        );
        void (async () => {
          try {
            const segment = await fetchSegment(index);
            if (
              activeRef.current !== playback ||
              version !== playback.seekVersion
            )
              return;
            if (index + 1 < playback.segments.length)
              playback.prefetched = prefetchSegment(index + 1);
            await playSegment(index, segment, fraction, version);
          } catch (cause) {
            if (
              controller.signal.aborted ||
              activeRef.current !== playback ||
              version !== playback.seekVersion
            )
              return;
            fail(
              cause instanceof Error
                ? cause.message
                : "Speech generation failed.",
            );
          }
        })();
      };
      try {
        const first = await fetchSegment(0);
        if (
          activeRef.current !== playback ||
          playback.seekVersion !== initialSeekVersion
        )
          return;
        if (playback.segments.length > 1)
          playback.prefetched = prefetchSegment(1);
        await playSegment(0, first);
      } catch (cause) {
        if (controller.signal.aborted || activeRef.current !== playback) return;
        const messageText =
          cause instanceof Error ? cause.message : "Speech generation failed.";
        fail(messageText);
      }
    },
    [fail, finishClose, pluginId, release, stop],
  );

  const togglePause = useCallback(() => {
    const playback = activeRef.current;
    if (playback?.audio === null || playback === null) return;
    if (playback.audio.paused) {
      if (playback.audioContext?.state === "suspended")
        void playback.audioContext.resume();
      playback.isPlaying = true;
      void playback.audio.play();
      setActive((view) => (view ? { ...view, state: "playing" } : view));
    } else {
      playback.isPlaying = false;
      playback.audio.pause();
      setActive((view) => (view ? { ...view, state: "paused" } : view));
    }
  }, []);

  useEffect(() => {
    const onPlayRequest = (message: ThreadChatMessageReference) =>
      void play(message);
    playListeners.add(onPlayRequest);
    return () => {
      playListeners.delete(onPlayRequest);
    };
  }, [play]);

  useEffect(() => {
    const mount = portalTarget;
    if (!mount) return;
    let intersecting = true;
    let frame = 0;
    const update = () => setInlineVisible(mount.isConnected && intersecting);
    const reveal = () => {
      if (!revealPendingRef.current || !mount.isConnected) return;
      revealPendingRef.current = false;
      mount.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    };
    const reattach = () => {
      frame = 0;
      const messageId = anchorMessageIdRef.current;
      if (messageId && !mount.isConnected) {
        const column = findMessageColumn(messageId);
        if (column) {
          column.append(mount);
          if (typeof mount.animate === "function" && !prefersReducedMotion()) {
            mount.animate([{ opacity: 0 }, { opacity: 1 }], {
              duration: 260,
              easing: EASE_OUT,
            });
          }
        }
      }
      update();
      reveal();
    };
    const mutations = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(reattach);
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    const visibility =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            intersecting = entries.some((entry) => entry.isIntersecting);
            update();
          });
    visibility?.observe(mount);
    reattach();
    return () => {
      mutations.disconnect();
      visibility?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [portalTarget]);

  const openSession = useCallback(() => {
    const mount = portalTargetRef.current;
    if (!mount || !sessionThreadId) return;
    revealPendingRef.current = true;
    if (mount.isConnected) {
      revealPendingRef.current = false;
      mount.scrollIntoView({
        block: "center",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      return;
    }
    if (context.threadId !== sessionThreadId) navigate.toThread(sessionThreadId);
  }, [context.threadId, navigate, sessionThreadId]);

  useEffect(
    () => () => {
      portalTargetRef.current?.remove();
      portalTargetRef.current = null;
      releaseSpaceHandoff();
    },
    [],
  );

  useEffect(
    () => () => {
      const playback = activeRef.current;
      if (!playback) return;
      activeRef.current = null;
      playback.controller.abort();
      playback.audio?.pause();
      if (playback.progressTimer !== null) {
        window.clearInterval(playback.progressTimer);
        playback.progressTimer = null;
      }
      if (playback.audio) {
        playback.audio.removeAttribute("src");
        playback.audio.load();
      }
      for (const url of playback.urls) URL.revokeObjectURL(url);
      void playback.audioContext?.close();
    },
    [],
  );

  const player =
    active || error ? (
      <PlayerCard
        key={presentation}
        active={active}
        error={error}
        analyser={analyser}
        onPause={togglePause}
        onSeek={(progress) => activeRef.current?.seek?.(progress)}
        closing={closing}
        onStop={stop}
        onDismiss={() => setClosing(true)}
        onExited={finishClose}
      />
    ) : null;
  return (
    <>
      {player && portalTarget ? createPortal(player, portalTarget) : null}
      <MiniPlayer
        visible={!inlineVisible && !closing}
        active={active}
        error={error}
        threadId={sessionThreadId}
        analyser={analyser}
        onPause={togglePause}
        onSeek={(progress) => activeRef.current?.seek?.(progress)}
        onStop={stop}
        onDismiss={() => setClosing(true)}
        onOpen={openSession}
      />
    </>
  );
}

const readAloudAction = {
  id: "read-aloud",
  title: "Read response aloud / stop playback",
  icon: "Play",
  experimental_roles: ["assistant"],
  run({ message }: { message: ThreadChatMessageReference }) {
    if (message.role !== "assistant") return;
    requestReadAloud(message);
  },
};

export default definePluginApp((app) => {
  app.slots.messageAction(readAloudAction);
  app.slots.experimental_appOverlay({
    id: "playback",
    component: ReadAloudAction,
  });
});
