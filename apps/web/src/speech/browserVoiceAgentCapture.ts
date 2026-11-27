import type { VoiceAgentCapturePort } from "@t3tools/client-runtime/voice-agent";
import { VOICE_AGENT_INPUT_FRAME_BYTES, VOICE_AGENT_SAMPLE_RATE } from "@t3tools/contracts";

import { requestMicrophone } from "./requestMicrophone";
import workletUrl from "./pcmWorklet.ts?worker&url";

/**
 * Voice mode plays the agent while the microphone is open, so the browser must remove the agent's
 * voice from what it captures. Named explicitly instead of relying on each browser's default.
 */
const VOICE_AGENT_MICROPHONE_PROCESSING = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} satisfies MediaTrackConstraints;

type Capture = {
  stopped: boolean;
  failed: boolean;
  stream: MediaStream | null;
  context: AudioContext | null;
  node: AudioWorkletNode | null;
};

export function createBrowserVoiceAgentCapture(input: {
  readonly getMicrophoneId: () => string | Promise<string>;
  readonly onLevel: (level: number) => void;
}): VoiceAgentCapturePort {
  let current: Capture | null = null;

  const release = (capture: Capture) => {
    capture.stopped = true;
    if (current === capture) current = null;
    capture.node?.disconnect();
    capture.node?.port.close();
    capture.node = null;
    capture.stream?.getTracks().forEach((track) => track.stop());
    capture.stream = null;
    void capture.context?.close().catch(() => undefined);
    capture.context = null;
  };

  return {
    async start({ signal, onFrame, onFailure }) {
      if (current) release(current);
      const capture: Capture = {
        stopped: false,
        failed: false,
        stream: null,
        context: null,
        node: null,
      };
      current = capture;
      // `stop()` can arrive without the signal, so both end a start that is still opening.
      const check = () => {
        signal.throwIfAborted();
        if (capture.stopped) throw new DOMException("Microphone capture stopped.", "AbortError");
      };
      const fail = (code: "microphone-disconnected" | "microphone-failed") => {
        if (capture.stopped || capture.failed) return;
        capture.failed = true;
        onFailure(code);
      };
      try {
        const microphoneId = await input.getMicrophoneId();
        check();
        const stream = await requestMicrophone(
          microphoneId,
          signal,
          VOICE_AGENT_MICROPHONE_PROCESSING,
        );
        capture.stream = stream;
        check();

        // Firefox cannot connect a microphone to a context at another rate; its default rate works
        // because the worklet resamples, up as well as down.
        const open = (options?: AudioContextOptions) => {
          const context = new AudioContext(options);
          try {
            return { context, source: context.createMediaStreamSource(stream) };
          } catch (error) {
            void context.close().catch(() => undefined);
            throw error;
          }
        };
        let graph: ReturnType<typeof open>;
        try {
          // Not the default rate: that is the output device's, which a headset can put below 24 kHz.
          graph = open({ sampleRate: VOICE_AGENT_SAMPLE_RATE });
        } catch {
          graph = open();
        }
        const { context, source } = graph;
        capture.context = context;

        await context.audioWorklet.addModule(workletUrl);
        check();
        const node = new AudioWorkletNode(context, "t3-pcm-capture", {
          channelCount: 1,
          processorOptions: {
            pcm16: {
              sampleRate: VOICE_AGENT_SAMPLE_RATE,
              frameSamples: VOICE_AGENT_INPUT_FRAME_BYTES / 2,
            },
          },
        });
        capture.node = node;
        node.port.onmessage = ({
          data,
        }: MessageEvent<Int16Array<ArrayBuffer> | number | "stopped" | "limit">) => {
          if (capture.stopped) return;
          if (typeof data === "number") input.onLevel(data);
          else if (typeof data !== "string") onFrame(data);
        };
        node.onprocessorerror = () => fail("microphone-failed");
        for (const track of stream.getTracks())
          track.addEventListener("ended", () => fail("microphone-disconnected"), { once: true });
        source.connect(node);
        // The processor emits silence, keeping the graph active without microphone playback.
        node.connect(context.destination);
        await context.resume();
        check();
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- AudioWorklet MessagePorts do not accept a target origin
        node.port.postMessage("start");
      } catch (error) {
        release(capture);
        throw error;
      }
    },
    stop() {
      if (current) release(current);
      input.onLevel(0);
    },
  };
}
