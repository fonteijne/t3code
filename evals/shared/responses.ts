import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { proxyConfig } from "./proxy.ts";

const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      output: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
      usage: Schema.optional(Schema.Struct({ total_tokens: Schema.optional(Schema.Number) })),
    }),
  ),
);

/** `POST {proxy}/responses`, retried on transient failures. Any other status is a defect. */
export const postResponses = Effect.fn("evals.postResponses")(function* (
  proxy: ReturnType<typeof proxyConfig>,
  body: unknown,
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 4,
    }),
  );
  const response = yield* HttpClientRequest.post(`${proxy.url}/responses`).pipe(
    HttpClientRequest.setHeaders(proxy.headers),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  const text = yield* response.text;
  if (response.status !== 200)
    return yield* Effect.die(new Error(`Model API ${response.status}: ${text}`));
  return decodeResponse(text);
});
