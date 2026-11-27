export interface RecordedCall {
  readonly name: string;
  /** Parsed arguments, or null when they were not JSON. */
  readonly arguments: Readonly<Record<string, unknown>> | null;
  /** Whether the server's decoder for this tool accepted them. False for an unknown tool. */
  readonly valid: boolean;
}

type Patterns = RegExp | ReadonlyArray<RegExp>;

export interface CallMatcher {
  readonly tool: string;
  /** Every pattern must match the argument: its text, or its JSON text when it is not a string. */
  readonly args?: Readonly<Record<string, Patterns>>;
  /** Most words a string argument may have. */
  readonly maxWords?: Readonly<Record<string, number>>;
}

export interface Expectation {
  /** Each matcher must match at least one call. */
  readonly calls?: ReadonlyArray<CallMatcher>;
  /** No call may match any of these. A matcher without `args` forbids the tool. */
  readonly callsMustNot?: ReadonlyArray<CallMatcher>;
  /** No tool call at all. */
  readonly noCalls?: true;
  readonly spokenMust?: ReadonlyArray<RegExp>;
  readonly spokenMustNot?: ReadonlyArray<RegExp>;
  /** Defaults to SPOKEN_MAX_WORDS. */
  readonly spokenMaxWords?: number;
  /** Each must match what was spoken or a string argument of some call. */
  readonly anywhereMust?: ReadonlyArray<RegExp>;
}

/** "One to three sentences is normal", with room for a question and its choices. */
export const SPOKEN_MAX_WORDS = 80;

const wordCount = (text: string) => text.split(/\s+/).filter((word) => word !== "").length;

const argumentText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

const patternList = (patterns: Patterns): ReadonlyArray<RegExp> =>
  patterns instanceof RegExp ? [patterns] : patterns;

const describe = (matcher: CallMatcher) => {
  const args = Object.entries(matcher.args ?? {}).map(
    ([key, patterns]) => `${key} ~ ${patternList(patterns).map(String).join(" ")}`,
  );
  const words = Object.entries(matcher.maxWords ?? {}).map(
    ([key, limit]) => `${key} <= ${limit} words`,
  );
  const detail = [...args, ...words];
  return detail.length === 0 ? matcher.tool : `${matcher.tool} call matched ${detail.join(", ")}`;
};

const matches = (matcher: CallMatcher, call: RecordedCall) => {
  if (call.name !== matcher.tool) return false;
  for (const [key, patterns] of Object.entries(matcher.args ?? {})) {
    if (call.arguments === null || !(key in call.arguments)) return false;
    const text = argumentText(call.arguments[key]);
    if (!patternList(patterns).every((pattern) => pattern.test(text))) return false;
  }
  for (const [key, limit] of Object.entries(matcher.maxWords ?? {})) {
    const value = call.arguments?.[key];
    if (typeof value !== "string" || wordCount(value) > limit) return false;
  }
  return true;
};

export const grade = (
  expect: Expectation,
  sample: { readonly calls: ReadonlyArray<RecordedCall>; readonly spoken: string },
): { readonly pass: boolean; readonly reasons: ReadonlyArray<string> } => {
  const reasons: Array<string> = [];
  for (const call of sample.calls) {
    if (!call.valid) reasons.push(`${call.name} was called with arguments the server rejects`);
  }
  const limit = expect.spokenMaxWords ?? SPOKEN_MAX_WORDS;
  const spokenWords = wordCount(sample.spoken);
  if (spokenWords > limit) reasons.push(`spoke ${spokenWords} words, limit ${limit}`);
  if (expect.noCalls && sample.calls.length > 0) {
    reasons.push(`expected no tool call, got ${sample.calls.map((call) => call.name).join(", ")}`);
  }
  for (const matcher of expect.calls ?? []) {
    if (!sample.calls.some((call) => matches(matcher, call))) {
      reasons.push(`no ${describe(matcher)}`);
    }
  }
  for (const matcher of expect.callsMustNot ?? []) {
    if (sample.calls.some((call) => matches(matcher, call))) {
      reasons.push(`a forbidden ${describe(matcher)}`);
    }
  }
  for (const pattern of expect.spokenMust ?? []) {
    if (!pattern.test(sample.spoken)) reasons.push(`spoken text does not match ${pattern}`);
  }
  for (const pattern of expect.spokenMustNot ?? []) {
    if (pattern.test(sample.spoken)) reasons.push(`spoken text matches ${pattern}`);
  }
  const argumentTexts = sample.calls.flatMap((call) =>
    Object.values(call.arguments ?? {}).filter((value) => typeof value === "string"),
  );
  for (const pattern of expect.anywhereMust ?? []) {
    if (![sample.spoken, ...argumentTexts].some((text) => pattern.test(text))) {
      reasons.push(`neither speech nor any argument matches ${pattern}`);
    }
  }
  return { pass: reasons.length === 0, reasons };
};
