import { VOICE_AGENT_STREAM_PATH } from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import { getEnvironmentMediaSocketUrl } from "../voice-input/environment.ts";

/** One ticket and one URL per start. A failure belongs to this request; nothing retries it. */
export const getEnvironmentVoiceAgentStreamUrl = (prepared: PreparedConnection) =>
  getEnvironmentMediaSocketUrl(prepared, VOICE_AGENT_STREAM_PATH);
