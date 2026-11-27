// Voice tools call the service methods that the composer's RPCs and the MCP thread tools already
// call. They add no thread logic of their own, and they never answer a permission request.
import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProjectId,
  type ProviderInteractionMode,
  ProviderRequestKind,
  type RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  type ThreadId,
  VoiceAgentError,
  type VoiceAgentLaunchSettings,
  isRuntimeModeAbove,
  linkOriginIsFenced,
} from "@t3tools/contracts";
import {
  SUBAGENT_RESULT_TURN_ITEM_TYPES,
  subagentResultForRun,
} from "@t3tools/provider-core/server/subagentProjection";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { truncate } from "@t3tools/shared/String";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { isProviderSignOutPrompt } from "../orchestration-v2/CommandPolicy.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  decodeAnswerArguments,
  decodeNoArguments,
  decodeSendArguments,
  decodeSwitchArguments,
  fenceAgentText,
  shortenAgentReply,
  shownQuestionId,
  shownRequestId,
  unfenceAgentText,
  VOICE_AGENT_TOOL_ERRORS,
  VOICE_AGENT_TOOLS,
  type VoiceAgentContext,
  type VoiceAgentNote,
} from "./voiceAgentPrompt.ts";

/** The most a session may do: the narrowest modes of every thread it has been bound to. */
export interface VoiceAgentCeiling {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** Set when one of those threads was started through a link paired below full access. */
  readonly fencedLink: OrchestrationV2LinkOrigin | undefined;
}

export interface VoiceAgentBinding {
  readonly projectId: ProjectId;
  /** Null until the first forwarded request creates a thread. */
  readonly threadId: ThreadId | null;
  /** Random per session; with `calls` it makes command and message ids unique. */
  readonly sessionId: string;
  /** Tool calls this session has dispatched so far. */
  readonly calls: number;
  /** Null until a thread is bound, unless the session started with launch settings. Only ever narrows. */
  readonly ceiling: VoiceAgentCeiling | null;
  /** What the composer showed at `start`: a thread the voice agent creates uses it first. */
  readonly launch?: VoiceAgentLaunchSettings;
}

export interface VoiceAgentToolOutcome {
  readonly ok: boolean;
  /** JSON for the speech model. */
  readonly output: string;
  readonly binding: VoiceAgentBinding;
}

/** What the watcher reports: a note for the speech model, or whether the thread is working. */
export type VoiceAgentThreadNotice = { readonly threadId: ThreadId } & (
  | VoiceAgentNote
  | { readonly type: "activity"; readonly busy: boolean }
);

export class VoiceAgentThreads extends Context.Service<
  VoiceAgentThreads,
  {
    /** Checks the project and thread, and reads what the speech model is told at the start. */
    readonly open: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId | null;
      readonly sessionId: string;
      readonly launch?: VoiceAgentLaunchSettings;
    }) => Effect.Effect<
      { readonly binding: VoiceAgentBinding; readonly context: VoiceAgentContext },
      VoiceAgentError
    >;
    /** Runs one function call. Failures become an `{"error": ...}` output, never a failure here. */
    readonly execute: (
      binding: VoiceAgentBinding,
      call: { readonly callId: string; readonly name: string; readonly arguments: string },
    ) => Effect.Effect<VoiceAgentToolOutcome>;
    /** Settled turns and new pending requests of one thread. Never fails; resubscribes instead. */
    readonly watch: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
    }) => Stream.Stream<VoiceAgentThreadNotice>;
  }
>()("t3/voiceAgent/VoiceAgentThreads") {}

type ThreadStatus = NonNullable<VoiceAgentContext["thread"]>["status"];
type ThreadModes = Pick<OrchestrationV2AppThread, "runtimeMode" | "interactionMode" | "linkOrigin">;
type QuestionItem = Extract<OrchestrationV2TurnItem, { readonly type: "user_input_request" }>;
type ToolResult = {
  readonly ok: boolean;
  readonly output: Readonly<Record<string, unknown>>;
  /** Set when the call bound the session to another thread. */
  readonly bound?: { readonly threadId: ThreadId; readonly ceiling: VoiceAgentCeiling };
};

const QUEUED_OR_ACTIVE_RUN_STATUSES = [
  "queued",
  ...ThreadManagement.ACTIVE_RUN_STATUSES,
] as const satisfies ReadonlyArray<OrchestrationV2Run["status"]>;
const LISTED_THREADS = 10;
const OPTION_DESCRIPTION_MAX = 160;
const ECHOED_LABEL_MAX = 80;
const INSTRUCTION_FILE_MAX_BYTES = 200_000;
const WAIT_SLICE_MS = 600_000;
const RESUBSCRIBE_AFTER = "5 seconds";
// A question's request is written before its card; this bounds the wait for the card.
const QUESTION_ITEM_TIMEOUT = "30 seconds";

const TOOL_NAMES: ReadonlySet<string> = new Set(VOICE_AGENT_TOOLS.map((tool) => tool.name));

const isApprovalKind = Schema.is(ProviderRequestKind);
const encodeOutput = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const isAboveManagedCeiling = Schema.is(OrchestratorRuntimeModeAboveCeilingError);

const done = (output: ToolResult["output"], bound?: ToolResult["bound"]): ToolResult => ({
  ok: true,
  output,
  ...(bound === undefined ? {} : { bound }),
});
const refused = (error: string): ToolResult => ({ ok: false, output: { error } });

const ceilingOf = (thread: ThreadModes): VoiceAgentCeiling => ({
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  fencedLink:
    thread.linkOrigin !== undefined && linkOriginIsFenced(thread.linkOrigin)
      ? thread.linkOrigin
      : undefined,
});

/** Whether binding to the thread would let the session act above its ceiling. */
const aboveCeiling = (ceiling: VoiceAgentCeiling | null, thread: ThreadModes): boolean =>
  ceiling !== null &&
  (isRuntimeModeAbove(thread.runtimeMode, ceiling.runtimeMode) ||
    (ceiling.interactionMode === "plan" && thread.interactionMode !== "plan") ||
    (ceiling.fencedLink !== undefined &&
      thread.linkOrigin?.sessionId !== ceiling.fencedLink.sessionId));

/** Never widens: the conversation still holds what the narrower thread said. */
const narrow = (ceiling: VoiceAgentCeiling | null, thread: ThreadModes): VoiceAgentCeiling => {
  const next = ceilingOf(thread);
  if (ceiling === null) return next;
  return {
    runtimeMode: isRuntimeModeAbove(next.runtimeMode, ceiling.runtimeMode)
      ? ceiling.runtimeMode
      : next.runtimeMode,
    interactionMode:
      ceiling.interactionMode === "plan" || next.interactionMode === "plan" ? "plan" : "default",
    fencedLink: ceiling.fencedLink ?? next.fencedLink,
  };
};

const lastTurnOf = (run: OrchestrationV2Run | undefined) =>
  run === undefined
    ? ("none" as const)
    : run.status === "completed"
      ? ("completed" as const)
      : run.status === "failed"
        ? ("failed" as const)
        : ("stopped" as const);

const threadStatusOf = (
  runs: ReadonlyArray<OrchestrationV2Run>,
  pendingRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>,
): ThreadStatus =>
  pendingRequests.some((request) => request.kind === "user_input")
    ? "waiting_for_answer"
    : pendingRequests.some((request) => isApprovalKind(request.kind))
      ? "waiting_for_approval"
      : runs.some(ThreadManagement.isActiveRun)
        ? "working"
        : "idle";

const isAnswerable = (request: OrchestrationV2RuntimeRequest) =>
  request.kind === "user_input" && request.responseCapability.type !== "not_resumable";

const questionItemOf = (
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  requestId: RuntimeRequestId,
) =>
  turnItems.find(
    (item): item is QuestionItem =>
      item.type === "user_input_request" && item.requestId === requestId,
  );

/** Text the coding agent wrote, as a tool result carries it. Nothing to fence when it is empty. */
const agentText = (text: string) => (text.trim() === "" ? "" : fenceAgentText(text));

/** An option label as the speech model saw it and may echo it: without its fence, in lower case. */
const shownLabel = (label: string) => unfenceAgentText(fenceAgentText(label)).toLowerCase();

const questionForModel = (question: OrchestrationV2UserInputQuestion) => ({
  id: agentText(shownQuestionId(question.id)),
  title: agentText(question.header),
  question: agentText(question.question),
  options: question.options.map((option) => ({
    label: agentText(option.label),
    description: agentText(option.description.slice(0, OPTION_DESCRIPTION_MAX)),
  })),
  multiple: question.multiSelect === true,
  free_text: question.allowCustomAnswer !== false,
  optional: question.required === false,
});

/** The answers a client would submit, keyed by question id, or the sentence that says what is missing. */
const answersFor = (
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  given: ReadonlyArray<{
    readonly question_id: string;
    readonly choices?: ReadonlyArray<string>;
    readonly text?: string;
  }>,
):
  | { readonly answers: Record<string, string | ReadonlyArray<string>> }
  | { readonly error: string } => {
  const answers: Record<string, string | ReadonlyArray<string>> = {};
  for (const question of questions) {
    const shownId = shownQuestionId(question.id);
    const answer = given.find(
      (candidate) =>
        candidate.question_id === question.id ||
        shownQuestionId(unfenceAgentText(candidate.question_id)) === shownId,
    );
    const text = answer?.text?.trim() ?? "";
    if (text !== "" && question.allowCustomAnswer !== false) {
      answers[question.id] = text;
      continue;
    }
    const values: Array<string> = [];
    for (const choice of answer?.choices ?? []) {
      // The label may come back with the fence it was listed in.
      const label = unfenceAgentText(choice).toLowerCase();
      const option = question.options.find(
        (candidate) =>
          candidate.value === choice ||
          candidate.label.trim().toLowerCase() === label ||
          shownLabel(candidate.label) === label,
      );
      if (option === undefined) {
        return {
          error: VOICE_AGENT_TOOL_ERRORS.unknownOption(
            unfenceAgentText(choice).slice(0, ECHOED_LABEL_MAX),
            question.header,
            question.options.map((candidate) => candidate.label),
          ),
        };
      }
      const value = option.value ?? option.label.trim();
      if (!values.includes(value)) values.push(value);
    }
    const first = values[0];
    if (first !== undefined) {
      answers[question.id] = question.multiSelect === true ? values : first;
    } else if (question.required !== false) {
      return { error: VOICE_AGENT_TOOL_ERRORS.answerMissing(question.header) };
    }
  }
  return { answers };
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const gitManager = yield* GitManager.GitManager;

  /** Voice mode binds only to threads `list_threads` would name: no side chats, no subagents. */
  const listedThreads = (projectId: ProjectId) =>
    threads.listProjectThreads({ projectId, includeSubagents: false });

  const replyOfRun = Effect.fn("VoiceAgentThreads.replyOfRun")(function* (
    threadId: ThreadId,
    run: OrchestrationV2Run,
  ) {
    const records = yield* threads.getThreadRecords(
      threadId,
      ["messages", "turnItems", "providerTurns"],
      {
        messageRoles: ["assistant"],
        messageRunIds: [run.id],
        turnItemRunIds: [run.id],
        turnItemTypes: SUBAGENT_RESULT_TURN_ITEM_TYPES,
        providerTurnAttemptIds: run.activeAttemptId === null ? [] : [run.activeAttemptId],
      },
    );
    const result = subagentResultForRun(records, run);
    // With neither id the text is the helper's placeholder for "no reply", not a reply.
    return shortenAgentReply(
      result.messageId === null && result.turnItemId === null ? "" : result.text,
    );
  });

  const threadStatus = Effect.fn("VoiceAgentThreads.threadStatus")(function* (target: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) {
    const records = yield* threads.getProjectThreadRecords(target, ["runs", "runtimeRequests"], {
      latestRunLimit: 2,
      runStatuses: QUEUED_OR_ACTIVE_RUN_STATUSES,
      runtimeRequestStatuses: ["pending"],
    });
    const status = threadStatusOf(records.runs, records.runtimeRequests);
    if (status !== "idle") return { thread: records.thread, status, idle: undefined };
    const lastRun = records.runs
      .filter((run) => ThreadManagement.isTerminalRunStatus(run.status))
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    return {
      thread: records.thread,
      status,
      idle: {
        lastTurn: lastTurnOf(lastRun),
        reply: lastRun === undefined ? "" : yield* replyOfRun(target.threadId, lastRun),
      },
    };
  });

  const statusOutput = (state: Effect.Success<ReturnType<typeof threadStatus>>) => ({
    thread: agentText(state.thread.title),
    status: state.status,
    ...(state.idle === undefined
      ? {}
      : { last_turn: state.idle.lastTurn, reply: agentText(state.idle.reply) }),
  });

  const pendingRequests = (target: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) =>
    threads.getProjectThreadRecords(target, ["runtimeRequests", "turnItems"], {
      runtimeRequestStatuses: ["pending"],
      turnItemTypes: ["user_input_request"],
    });

  const launchThread = Effect.fn("VoiceAgentThreads.launchThread")(function* (
    binding: VoiceAgentBinding,
    text: string,
  ) {
    if (binding.ceiling?.fencedLink !== undefined)
      return refused(VOICE_AGENT_TOOL_ERRORS.launchFenced);
    const { projectId } = binding;
    const project = Option.getOrUndefined(yield* projects.getById(projectId));
    if (project === undefined) return refused(VOICE_AGENT_TOOL_ERRORS.projectGone);
    const defaults = resolveProjectSettings(
      yield* settings.getSettings,
      projectId,
      project,
    ).settings;
    const { launch } = binding;
    const modelSelection =
      launch?.modelSelection ??
      resolveNewThreadModelSelection({
        defaultSelection: defaults.defaultModelSelection,
        fallbackSelection: defaults.fallbackModelSelection,
        providers: yield* registry.getProviders,
        settings: defaults,
        projectId,
        now: DateTime.toEpochMillis(yield* DateTime.now),
      }).selection ??
      (binding.threadId === null
        ? null
        : (yield* threads.getProjectThreadRecords({ projectId, threadId: binding.threadId }, []))
            .thread.modelSelection);
    if (modelSelection === null) return refused(VOICE_AGENT_TOOL_ERRORS.noDefaultModel);
    const ceiling = binding.ceiling;
    const wantedRuntimeMode = launch?.runtimeMode ?? defaults.defaultRuntimeMode;
    const runtimeMode =
      ceiling !== null && isRuntimeModeAbove(wantedRuntimeMode, ceiling.runtimeMode)
        ? ceiling.runtimeMode
        : wantedRuntimeMode;
    const interactionMode =
      ceiling?.interactionMode === "plan" ? "plan" : (launch?.interactionMode ?? "default");
    const workspaceStrategy = yield* launches.defaultWorkspaceStrategy({
      workspaceRoot: project.workspaceRoot,
      settings: defaults,
    });
    const commandId = CommandId.make(`voice:${binding.sessionId}:${binding.calls}`);
    if (workspaceStrategy.type === "worktree") {
      yield* launches.checkWorktreeBase({ commandId, projectId, workspaceStrategy });
    }
    // No thread id: the launch allocates one, so it cannot collide with a client's draft.
    const launched = yield* launches.launch({
      commandId,
      projectId,
      title: truncate(text),
      generateTitle: true,
      modelSelection,
      runtimeMode,
      interactionMode,
      workspaceStrategy,
      initialMessage: {
        messageId: MessageId.make(`voice:${binding.sessionId}:${binding.calls}`),
        text,
        attachments: [],
      },
      createdBy: "user",
      creationSource: "web",
    });
    const thread = launched.projection.thread;
    return done(
      { status: "started", new_thread: agentText(thread.title) },
      { threadId: launched.threadId, ceiling: narrow(ceiling, thread) },
    );
  });

  /** The request as the developer would have typed it, or the sentence that refuses it. */
  const forwardedRequest = (json: string) => {
    const args = decodeSendArguments(json);
    if (Option.isNone(args)) return { error: VOICE_AGENT_TOOL_ERRORS.notUnderstood };
    const text = args.value.message.trim();
    if (text === "") return { error: VOICE_AGENT_TOOL_ERRORS.emptyRequest };
    // Over RPC this prompt needs providers:manage; the voice route checks orchestration:operate only.
    if (isProviderSignOutPrompt({ text, attachments: [] }))
      return { error: VOICE_AGENT_TOOL_ERRORS.signOutRefused };
    return { text };
  };

  const sendToAgent = Effect.fn("VoiceAgentThreads.sendToAgent")(function* (
    binding: VoiceAgentBinding,
    json: string,
  ) {
    const request = forwardedRequest(json);
    if ("error" in request) return refused(request.error);
    if (binding.threadId === null) return yield* launchThread(binding, request.text);
    const id = `voice:${binding.sessionId}:${binding.calls}`;
    const sent = yield* threads.sendToThread({
      projectId: binding.projectId,
      commandId: CommandId.make(id),
      threadId: binding.threadId,
      messageId: MessageId.make(id),
      text: request.text,
      attachments: [],
      mode: "auto",
      // The developer's own request, spoken instead of typed.
      createdBy: "user",
      creationSource: "web",
    });
    return done({ status: sent.delivery === "restarted" ? "started" : sent.delivery });
  });

  const startThread = Effect.fn("VoiceAgentThreads.startThread")(function* (
    binding: VoiceAgentBinding,
    json: string,
  ) {
    const request = forwardedRequest(json);
    return "error" in request ? refused(request.error) : yield* launchThread(binding, request.text);
  });

  const interruptAgent = Effect.fn("VoiceAgentThreads.interruptAgent")(function* (
    binding: VoiceAgentBinding,
    threadId: ThreadId,
  ) {
    // The app's Stop button: it also holds the queue and stops delegated tasks.
    const stopped = yield* threads.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`voice:${binding.sessionId}:${binding.calls}`),
      threadId,
      reason: "Stopped by voice",
    });
    const interrupted = stopped.storedEvents.some(
      ({ event }) =>
        (event.type === "run.updated" && event.payload.status === "interrupted") ||
        (event.type === "turn-item.updated" &&
          event.payload.type === "run_interrupt_request" &&
          event.payload.providerTurnId !== null),
    );
    return done({ status: interrupted ? "stopping" : "not_running" });
  });

  const pendingQuestion = Effect.fn("VoiceAgentThreads.pendingQuestion")(function* (target: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) {
    const records = yield* pendingRequests(target);
    const approvalWaiting = records.runtimeRequests.some((request) => isApprovalKind(request.kind));
    for (const request of records.runtimeRequests
      .filter(isAnswerable)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
      )) {
      const item = questionItemOf(records.turnItems, request.id);
      if (item === undefined) continue;
      return done({
        request_id: shownRequestId(request.id),
        questions: item.questions.map(questionForModel),
        approval_waiting: approvalWaiting,
      });
    }
    return done({ request_id: null, approval_waiting: approvalWaiting });
  });

  const answerQuestion = Effect.fn("VoiceAgentThreads.answerQuestion")(function* (
    binding: VoiceAgentBinding,
    threadId: ThreadId,
    json: string,
  ) {
    const args = decodeAnswerArguments(json);
    if (Option.isNone(args)) return refused(VOICE_AGENT_TOOL_ERRORS.notUnderstood);
    const records = yield* pendingRequests({ projectId: binding.projectId, threadId });
    // Compared in the form the speech model was shown, which is all it can echo.
    const requestId = shownRequestId(args.value.request_id.trim());
    const request =
      requestId === ""
        ? undefined
        : records.runtimeRequests.find((candidate) => shownRequestId(candidate.id) === requestId);
    if (request === undefined) return refused(VOICE_AGENT_TOOL_ERRORS.questionGone);
    if (request.kind !== "user_input") return refused(VOICE_AGENT_TOOL_ERRORS.approvalRefused);
    const item = questionItemOf(records.turnItems, request.id);
    if (item === undefined || !isAnswerable(request))
      return refused(VOICE_AGENT_TOOL_ERRORS.questionGone);
    const built = answersFor(item.questions, args.value.answers);
    if ("error" in built) return refused(built.error);
    // No `decision` is ever set here, so this command cannot approve anything.
    yield* threads.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`voice:${binding.sessionId}:${binding.calls}`),
      threadId,
      requestId: request.id,
      answers: built.answers,
    });
    return done({ status: "answered" });
  });

  const listThreads = Effect.fn("VoiceAgentThreads.listThreads")(function* (
    binding: VoiceAgentBinding,
  ) {
    const listed = yield* listedThreads(binding.projectId);
    return done({
      threads: listed.slice(0, LISTED_THREADS).map((thread) => ({
        id: thread.id,
        title: agentText(thread.title),
        ...(thread.id === binding.threadId ? { current: true } : {}),
      })),
      ...(listed.length > LISTED_THREADS ? { more: listed.length - LISTED_THREADS } : {}),
    });
  });

  const switchThread = Effect.fn("VoiceAgentThreads.switchThread")(function* (
    binding: VoiceAgentBinding,
    json: string,
  ) {
    const args = decodeSwitchArguments(json);
    if (Option.isNone(args)) return refused(VOICE_AGENT_TOOL_ERRORS.notUnderstood);
    const wanted = args.value.thread_id.trim();
    const listed = (yield* listedThreads(binding.projectId)).find((thread) => thread.id === wanted);
    if (listed === undefined) return refused(VOICE_AGENT_TOOL_ERRORS.threadNotListed);
    const state = yield* threadStatus({ projectId: binding.projectId, threadId: listed.id });
    if (aboveCeiling(binding.ceiling, state.thread))
      return refused(VOICE_AGENT_TOOL_ERRORS.threadAboveCeiling);
    return done(statusOutput(state), {
      threadId: listed.id,
      ceiling: narrow(binding.ceiling, state.thread),
    });
  });

  const runTool = (
    binding: VoiceAgentBinding,
    call: { readonly name: string; readonly arguments: string },
  ) => {
    const { projectId, threadId } = binding;
    switch (call.name) {
      case "send_to_agent":
        return sendToAgent(binding, call.arguments);
      case "start_thread":
        return startThread(binding, call.arguments);
      case "list_threads":
        return Option.isNone(decodeNoArguments(call.arguments))
          ? Effect.succeed(refused(VOICE_AGENT_TOOL_ERRORS.notUnderstood))
          : listThreads(binding);
      case "switch_thread":
        return switchThread(binding, call.arguments);
      case "answer_agent_question":
        return threadId === null
          ? Effect.succeed(refused(VOICE_AGENT_TOOL_ERRORS.noThread))
          : answerQuestion(binding, threadId, call.arguments);
      case "read_agent_reply":
      case "interrupt_agent":
      case "get_pending_question": {
        if (Option.isNone(decodeNoArguments(call.arguments))) {
          return Effect.succeed(refused(VOICE_AGENT_TOOL_ERRORS.notUnderstood));
        }
        if (call.name === "read_agent_reply") {
          return threadId === null
            ? Effect.succeed(done({ status: "no_thread" }))
            : threadStatus({ projectId, threadId }).pipe(
                Effect.map((state) => done(statusOutput(state))),
              );
        }
        if (threadId === null) return Effect.succeed(refused(VOICE_AGENT_TOOL_ERRORS.noThread));
        return call.name === "interrupt_agent"
          ? interruptAgent(binding, threadId)
          : pendingQuestion({ projectId, threadId });
      }
      default:
        return Effect.succeed(refused(VOICE_AGENT_TOOL_ERRORS.unknownTool));
    }
  };

  /** What the speech model is told when a service refused the call. */
  const toolFailure = (error: Effect.Error<ReturnType<typeof runTool>>): string => {
    switch (error._tag) {
      case "ThreadManagementThreadNotFoundError":
        return VOICE_AGENT_TOOL_ERRORS.threadGone;
      case "ThreadManagementThreadArchivedError":
        return VOICE_AGENT_TOOL_ERRORS.threadArchived;
      case "ThreadManagementProviderInstanceDisabledError":
        return VOICE_AGENT_TOOL_ERRORS.providerDisabled;
      case "ThreadManagementWorktreeRestoreError":
        return VOICE_AGENT_TOOL_ERRORS.workspaceMissing;
      // Already written for the user; the app shows the same text for a launch it refuses.
      case "ThreadLaunchBaseRefError":
      case "ThreadLaunchBranchExistsError":
      case "ThreadLaunchBranchConflictError":
      case "ThreadLaunchNotRepositoryError":
      case "TaskFolderError":
        return error.message;
      case "ThreadLaunchBranchUnreadableError":
        return `${error.message} ${VOICE_AGENT_TOOL_ERRORS.noThreadCreated}`;
      case "ThreadLaunchError":
        if (isAboveManagedCeiling(error.cause)) return error.cause.message;
        break;
      default:
        break;
    }
    return userFacingDispatchErrorMessage(error) ?? VOICE_AGENT_TOOL_ERRORS.failed;
  };

  const execute: VoiceAgentThreads["Service"]["execute"] = Effect.fn("VoiceAgentThreads.execute")(
    function* (binding, call) {
      // The name is the endpoint's string, so only a known one is recorded.
      const tool = TOOL_NAMES.has(call.name) ? call.name : "unknown";
      yield* Effect.annotateCurrentSpan({ "voice.tool": tool });
      const raised = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      const { ceiling } = binding;
      const result = yield* runTool(binding, call).pipe(
        // The orchestrator rechecks under the thread's lock: its modes may have been raised in the
        // app since the session was bound. Stopping starts no work, so it stays open.
        ceiling === null || call.name === "interrupt_agent"
          ? (effect) => effect
          : Effect.provideService(DispatchModeLimit, {
              runtimeMode: ceiling.runtimeMode,
              interactionMode: ceiling.interactionMode,
              refused: raised,
            }),
        Effect.catch((error) =>
          Effect.gen(function* () {
            // Arguments, texts and outputs are never logged: they are what the developer said.
            yield* Effect.logWarning("A voice agent tool call failed.", {
              tool,
              errorTag: error._tag,
            });
            const refusal = yield* Ref.get(raised);
            if (refusal === undefined) return refused(toolFailure(error));
            // The orchestrator lowers the limit to the administrator's ceiling first, so a thread
            // within the session's own ceiling was refused for that one.
            return refused(
              ceiling !== null && exceededDispatchModeLimit(ceiling, refusal) !== undefined
                ? VOICE_AGENT_TOOL_ERRORS.threadRaised
                : VOICE_AGENT_TOOL_ERRORS.threadAboveManagedLimit,
            );
          }),
        ),
      );
      return {
        ok: result.ok,
        output: encodeOutput(result.output),
        // The endpoint's call id is never part of a persisted id; this counter is.
        binding: { ...binding, ...result.bound, calls: binding.calls + 1 },
      };
    },
  );

  const open: VoiceAgentThreads["Service"]["open"] = Effect.fn("VoiceAgentThreads.open")(
    function* (input) {
      const { projectId, threadId, sessionId, launch } = input;
      const notFound = new VoiceAgentError({ reason: "not-found" });
      const project = yield* projects.getById(projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (project === undefined) return yield* notFound;
      const state =
        threadId === null
          ? null
          : yield* listedThreads(projectId).pipe(
              Effect.filterOrFail(
                (listed) => listed.some((thread) => thread.id === threadId),
                () => notFound,
              ),
              Effect.andThen(threadStatus({ projectId, threadId })),
              Effect.catch((error) =>
                error._tag === "VoiceAgentError" ||
                error._tag === "ThreadManagementThreadNotFoundError"
                  ? Effect.fail(notFound)
                  : Effect.logWarning("A voice session could not read its thread.", {
                      errorTag: error._tag,
                    }).pipe(
                      Effect.andThen(Effect.fail(new VoiceAgentError({ reason: "internal" }))),
                    ),
              ),
            );
      // The project folder's files, once: a thread's worktree copy is the coding agent's to read.
      const instructions = (fileName: string) =>
        gitManager.readRepositoryInstructions(
          project.workspaceRoot,
          fileName,
          INSTRUCTION_FILE_MAX_BYTES,
        );
      const agentsFile = yield* instructions("AGENTS.md");
      const claudeFile = yield* instructions("CLAUDE.md");
      return {
        binding: {
          projectId,
          threadId,
          sessionId,
          calls: 0,
          // Unbound, nothing may launch above what the composer showed.
          ceiling:
            state !== null
              ? ceilingOf(state.thread)
              : launch === undefined
                ? null
                : {
                    runtimeMode: launch.runtimeMode,
                    interactionMode: launch.interactionMode,
                    fencedLink: undefined,
                  },
          ...(launch === undefined ? {} : { launch }),
        },
        context: {
          projectTitle: project.title,
          thread: state === null ? null : { title: state.thread.title, status: state.status },
          agentsFile,
          claudeFile,
        },
      };
    },
  );

  const watch: VoiceAgentThreads["Service"]["watch"] = (input) => {
    const { threadId } = input;
    const logFailure = (stage: string) => (error: { readonly _tag: string }) =>
      Effect.logWarning("The voice agent's thread watcher failed and continues.", {
        stage,
        errorTag: error._tag,
      });
    return Stream.unwrap(
      Effect.gen(function* () {
        const notices = yield* Queue.bounded<VoiceAgentThreadNotice>(16);
        // One slot: a burst of ended runs settles once.
        const settleCandidates = yield* Queue.sliding<RunId>(1);
        const initial = yield* Effect.gen(function* () {
          // Taken before the first read, so an update between that read and the subscriptions replays.
          const afterSequence = yield* threads.getThreadEventSequence(threadId);
          const records = yield* threads.getProjectThreadRecords(
            input,
            ["runs", "runtimeRequests"],
            {
              runStatuses: QUEUED_OR_ACTIVE_RUN_STATUSES,
              runtimeRequestStatuses: ["pending"],
            },
          );
          return { afterSequence, records };
        }).pipe(
          Effect.tapError(logFailure("subscribe")),
          Effect.retry({
            schedule: Schedule.spaced(RESUBSCRIBE_AFTER),
            while: (error) => error._tag !== "ThreadManagementThreadNotFoundError",
          }),
          Effect.orElseSucceed(() => undefined),
        );
        // The thread is gone. Nothing will happen on it; the next tool call says so.
        if (initial === undefined) return Stream.never;
        const activeRunIds = new Set(
          initial.records.runs.filter(ThreadManagement.isActiveRun).map((run) => run.id),
        );
        const announcedRuns = new Set<RunId>();
        // Requests already pending are in the session's start context or tool result, not news.
        const announcedRequests = new Set(
          initial.records.runtimeRequests.map((request) => request.id),
        );
        // A thread that is already working must count as busy from the first moment.
        yield* Queue.offer(notices, {
          type: "activity",
          threadId,
          busy: activeRunIds.size > 0,
        });

        // One stream per event type, so transcript and tool-output events never reach this watcher.
        const events = (
          eventType: "run.updated" | "runtime-request.updated",
          handle: (stored: OrchestrationV2StoredEvent) => Effect.Effect<void>,
        ) => {
          let lastSequence = initial.afterSequence;
          return Stream.suspend(() =>
            threads.streamStoredEventsFrom({ threadId, afterSequence: lastSequence, eventType }),
          ).pipe(
            Stream.tapError(logFailure(eventType)),
            Stream.retry(Schedule.spaced(RESUBSCRIBE_AFTER)),
            Stream.runForEach((stored) => {
              lastSequence = stored.sequence;
              return handle(stored);
            }),
            Effect.orDie,
          );
        };

        // Runs for every run update of the thread, with no read; the watcher has no span of its own.
        const onRunUpdate = Effect.fnUntraced(function* (stored: OrchestrationV2StoredEvent) {
          if (stored.event.type !== "run.updated") return;
          const run = stored.event.payload;
          const wasBusy = activeRunIds.size > 0;
          if (ThreadManagement.isActiveRun(run)) activeRunIds.add(run.id);
          else activeRunIds.delete(run.id);
          const busy = activeRunIds.size > 0;
          if (busy !== wasBusy) yield* Queue.offer(notices, { type: "activity", threadId, busy });
          if (ThreadManagement.isTerminalRunStatus(run.status)) {
            yield* Queue.offer(settleCandidates, run.id);
          }
        });

        const settle = Effect.fn("VoiceAgentThreads.settle")(function* (runId: RunId) {
          // The existing definition of "the turn is really over": it follows a restart to its
          // continuation and waits for the thread's own delegated work and its final answer.
          const wait = threads.waitForThread({
            ...input,
            runId,
            timeoutMs: WAIT_SLICE_MS,
            untilDelegatedWorkSettled: true,
          });
          let waited = yield* wait;
          while (waited.timedOut) waited = yield* wait;
          const final = waited.resultRun ?? waited.run;
          if (final === null || announcedRuns.has(final.id)) return;
          for (const id of [runId, waited.run?.id, final.id]) {
            if (id !== undefined) announcedRuns.add(id);
          }
          const { runs, thread } = yield* threads.getProjectThreadRecords(input, ["runs"], {
            runStatuses: QUEUED_OR_ACTIVE_RUN_STATUSES,
          });
          // More turns are coming; the last one reports.
          if (
            runs.some(
              (run) =>
                ThreadManagement.isActiveRun(run) ||
                (run.status === "queued" && run.queueHeld !== true),
            )
          ) {
            return;
          }
          const outcome = lastTurnOf(final);
          if (outcome === "none") return;
          yield* Queue.offer(notices, {
            type: "turn-settled",
            threadId,
            threadTitle: thread.title,
            outcome,
            reply: yield* replyOfRun(threadId, final),
          });
        });

        const questionItem = Effect.fn("VoiceAgentThreads.questionItem")(function* (
          requestId: RuntimeRequestId,
          sequence: number,
        ) {
          const read = threads
            .getProjectThreadRecords(input, ["turnItems"], {
              turnItemRequestIds: [requestId],
              turnItemTypes: ["user_input_request"],
            })
            .pipe(Effect.map((records) => questionItemOf(records.turnItems, requestId)));
          const item = yield* read;
          if (item !== undefined) return item;
          // A provider reports the request before its card. Wait for that one card, briefly.
          const arrived = yield* threads
            .streamStoredEventsFrom({
              threadId,
              afterSequence: sequence,
              eventType: "turn-item.updated",
            })
            .pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "turn-item.updated" &&
                  event.payload.type === "user_input_request" &&
                  event.payload.requestId === requestId,
              ),
              Stream.runHead,
              Effect.timeoutOption(QUESTION_ITEM_TIMEOUT),
            );
          return Option.isSome(Option.flatten(arrived)) ? yield* read : undefined;
        });

        const onRequestUpdate = Effect.fn("VoiceAgentThreads.onRequestUpdate")(function* (
          stored: OrchestrationV2StoredEvent,
        ) {
          if (stored.event.type !== "runtime-request.updated") return;
          const request = stored.event.payload;
          if (request.status !== "pending" || announcedRequests.has(request.id)) return;
          announcedRequests.add(request.id);
          if (isApprovalKind(request.kind)) {
            // Only the kind: the approval's own prompt is text the coding agent wrote, and the
            // developer decides in the app, where the full request is shown.
            yield* Queue.offer(notices, {
              type: "approval-pending",
              threadId,
              requestKind: request.kind,
            });
            return;
          }
          if (!isAnswerable(request)) return;
          const item = yield* questionItem(request.id, stored.sequence);
          if (item === undefined) return;
          yield* Queue.offer(notices, {
            type: "question-pending",
            threadId,
            requestId: request.id,
            questions: item.questions,
          });
        });

        yield* Effect.forkScoped(events("run.updated", onRunUpdate));
        yield* Effect.forkScoped(
          Queue.take(settleCandidates).pipe(
            Effect.flatMap(settle),
            Effect.catch(logFailure("settle")),
            Effect.forever,
          ),
        );
        yield* Effect.forkScoped(
          events("runtime-request.updated", (stored) =>
            onRequestUpdate(stored).pipe(Effect.catch(logFailure("request"))),
          ),
        );
        return Stream.fromQueue(notices);
      }),
    );
  };

  return VoiceAgentThreads.of({ open, execute, watch });
});

export const layer = Layer.effect(VoiceAgentThreads, make);
