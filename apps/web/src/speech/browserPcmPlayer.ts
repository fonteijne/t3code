import type {
  VoiceAgentPlaybackCut,
  VoiceAgentPlaybackPort,
} from "@t3tools/client-runtime/voice-agent";
import { VOICE_AGENT_MAX_BUFFERED_PLAYBACK_MS, VOICE_AGENT_SAMPLE_RATE } from "@t3tools/contracts";

import type { PcmPlayerPosition } from "./pcmPlayerQueue";
import playerWorkletUrl from "./pcmPlayerWorklet.ts?worker&url";

type FromPlayer =
  | number
  | { readonly type: "playing"; readonly playing: boolean }
  | ({ readonly type: "flushed"; readonly id: number } & PcmPlayerPosition);

type Player = {
  readonly context: AudioContext;
  readonly onPlayingChange: (playing: boolean) => void;
  /** Ends a start that is still waiting for the browser to let the context run. */
  readonly cancel: (reason: unknown) => void;
  node: AudioWorkletNode | null;
  /** True once `start` has resolved; audio is only accepted from then on. */
  started: boolean;
  stopped: boolean;
  failed: boolean;
};

const NOTHING_PLAYED: VoiceAgentPlaybackCut = { itemId: null, playedMs: 0, pending: false };

export function createBrowserPcmPlayer(input: {
  readonly onLevel: (level: number) => void;
}): VoiceAgentPlaybackPort {
  let current: Player | null = null;
  let flushId = 0;
  const pendingFlushes = new Map<number, (cut: VoiceAgentPlaybackCut) => void>();

  const release = (player: Player) => {
    player.stopped = true;
    if (current === player) current = null;
    player.cancel(new DOMException("Playback stopped.", "AbortError"));
    for (const resolve of pendingFlushes.values()) resolve(NOTHING_PLAYED);
    pendingFlushes.clear();
    player.node?.disconnect();
    player.node?.port.close();
    player.node = null;
    player.context.onstatechange = null;
    void player.context.close().catch(() => undefined);
  };

  return {
    async start({ signal, onPlayingChange, onFailure }) {
      if (current) release(current);
      // Synchronous up to the first await: a browser only lets a context created and resumed
      // inside the starting gesture make sound.
      const context = new AudioContext({ sampleRate: VOICE_AGENT_SAMPLE_RATE });
      const gone = Promise.withResolvers<never>();
      void gone.promise.catch(() => undefined);
      const player: Player = {
        context,
        onPlayingChange,
        cancel: gone.reject,
        node: null,
        started: false,
        stopped: false,
        failed: false,
      };
      current = player;
      const resumed = context.resume();
      void resumed.catch(() => undefined);
      signal.addEventListener("abort", () => gone.reject(signal.reason), { once: true });
      const check = () => {
        signal.throwIfAborted();
        if (player.stopped) throw new DOMException("Playback stopped.", "AbortError");
      };
      const fail = () => {
        if (player.stopped || player.failed) return;
        player.failed = true;
        onFailure();
      };
      try {
        await context.audioWorklet.addModule(playerWorkletUrl);
        check();
        const node = new AudioWorkletNode(context, "t3-pcm-player", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: {
            capacitySamples:
              (VOICE_AGENT_MAX_BUFFERED_PLAYBACK_MS * VOICE_AGENT_SAMPLE_RATE) / 1_000,
          },
        });
        player.node = node;
        node.port.onmessage = ({ data }: MessageEvent<FromPlayer>) => {
          if (player.stopped) return;
          if (typeof data === "number") return input.onLevel(data);
          if (data.type === "playing") return onPlayingChange(data.playing);
          const resolve = pendingFlushes.get(data.id);
          pendingFlushes.delete(data.id);
          resolve?.({
            itemId: data.itemId,
            playedMs: Math.floor((data.positionSamples * 1_000) / VOICE_AGENT_SAMPLE_RATE),
            pending: data.pending,
          });
        };
        node.onprocessorerror = fail;
        context.onstatechange = () => {
          if (player.stopped) return;
          // Typed as a string: "interrupted" (Safari) is missing from older DOM typings.
          const state: string = context.state;
          if (state === "closed") return fail();
          // A device switch or an OS interruption can suspend a running context.
          if (player.started && (state === "suspended" || state === "interrupted"))
            void context.resume().catch(() => undefined);
        };
        node.connect(context.destination);
        // `resumed` only settles once the browser lets the context run; ending the start is the way out.
        await Promise.race([resumed, gone.promise]);
        check();
        player.started = true;
      } catch (error) {
        release(player);
        throw error;
      }
    },
    enqueue(pcm, itemId) {
      // Frames from the socket are never views of shared memory, which is all the DOM type excludes.
      if (!current?.started) return;
      current.node?.port.postMessage({ type: "enqueue", itemId, pcm }, [pcm.buffer as ArrayBuffer]);
    },
    flush() {
      const node = current?.started ? current.node : null;
      if (!node) return Promise.resolve(NOTHING_PLAYED);
      const id = ++flushId;
      return new Promise((resolve) => {
        pendingFlushes.set(id, resolve);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        node.port.postMessage({ type: "flush", id });
      });
    },
    stop() {
      const player = current;
      if (player) release(player);
      input.onLevel(0);
      player?.onPlayingChange(false);
    },
  };
}
