# Voice agent

Checks the voice mode conductor: the instructions and function tools the realtime speech model gets ([`voiceAgentPrompt.ts`](../../apps/server/src/voiceAgent/voiceAgentPrompt.ts)). Each case is a short spoken exchange with mocked tool results. It checks which tool the model calls, with which arguments, and how much it says.

A text model on the Responses API stands in for the speech model, so this measures what the text asks for, not how a realtime model sounds or how it handles real interruptions. Instructions, tool descriptions, schemas and the `[T3 Code]` messages all come from this checkout. `[T3 Code]` messages are sent as `system` messages, as the server sends them. Unlike the server, the eval leaves tools on when a turn ends on a message, so cases that end on one check the text alone.

## Run

```sh
cd evals
pnpm voice-agent --dry-run --out runs/voice-dry
pnpm voice-agent --model <id> --case approval-is-not-claimed --samples 1 --out runs/check
pnpm voice-agent --model <id> --out runs/voice
pnpm voice-agent --model <id> --out runs/voice-new --baseline runs/voice/results.ndjson
```

- Models go through a CLIProxyAPI server set up as the Codex model provider, as for [test-signal](../test-signal/README.md#run). `--dry-run` needs no key: it writes each case's request to `requests.ndjson`.
- Flags: `--model <id>` (repeatable, required), `--case <id>` (repeatable), `--samples <n>` (default 3), `--concurrency <n>` (default 6), `--reasoning <level>` (default `low`), `--baseline <results.ndjson>`.
- A case passes when more than half of its samples pass. `summary.md` gives the prompt hash and size, then per model the guards and controls that passed, errors and tokens.
- The checks are patterns. Read a failed case's samples in `results.ndjson` before you change text or a case.
- Cost: proxy quota only. A full run is 39 short conversations per model. Estimated at under 0.3M tokens; nobody has run it yet, so replace this line with the first real number.

## Add a case

Add an entry to `cases.ts`: the session (`context`), what was said before (`history`), what the developer says now (`says`, or nothing when a `[T3 Code]` message is the last thing that happened), mocked tool `results`, and `expect`. Write `[T3 Code]` messages as notices, never as text, and wrap what the coding agent wrote in a mocked result with `fenceAgentText`, as the server does. A `bad` case reproduces a failure someone saw: name the thread or issue in `source`, and check that it fails on the text before your fix.
