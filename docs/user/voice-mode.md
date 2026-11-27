# Voice mode

Voice mode (Labs) lets you talk with T3 Code instead of typing. A voice agent listens, passes what you ask to the coding agent in your thread, and tells you aloud what the agent did. The work still happens in the thread, where you can read it, review the diff, and keep typing at any time.

Voice mode is available on web and desktop. The mobile apps do not have it yet. To dictate text into a draft instead, see [Voice input](./voice-input.md).

## Set it up

Voice mode uses a realtime speech model on an OpenAI-compatible endpoint that you bring, such as OpenAI or your own gateway.

1. Turn on **Settings → Labs → Voice mode** on the environment.
2. In **Settings → Providers → Text generators**, add or edit an OpenAI-compatible [text generator](./text-generation.md). Under **Voice model (optional)**, pick a realtime model from the endpoint's list or type its name.
3. If several text generators have a voice model, choose one in **Settings → Voice → Voice agent**. A project can use a different one in its [project settings](./project-settings.md).

The endpoint's API key stays on the environment. Your browser and the desktop app never receive it.

## Start and end

- Press the voice mode button next to the microphone in the composer, run **Start voice mode** from the command palette, or use its shortcut (see [Keybindings](./keybindings.md)).
- The first time on each device, T3 Code names the environment, the endpoint and its address, and asks before it sends any audio. It asks again when the endpoint or its address changes. To withdraw your permission, use **Revoke** in **Settings → Voice → Voice agent**.
- Start from an open thread to talk about that thread. Start from a new draft to begin a new thread with your first request. That thread uses the model and permissions the draft shows when you start voice mode, and the project's default workspace. The app then follows the new thread.
- To end, press the button or the shortcut again, run **End voice mode**, or press **End** in the voice mode banner. While voice mode is on, your microphone is on; ending is how you turn it off.

## What to expect

- **It passes work on. It does not code.** A request about your project goes to the thread's coding agent as a normal message, in your words. The voice agent cannot read files or run commands, so it does not answer questions about your code itself.
- **It reports back without being asked.** When the coding agent finishes, asks a question, or needs an approval, the voice agent tells you. Its summaries are short. Ask for more detail, or read the thread.
- **It passes on answers, not approvals.** When the coding agent asks you a question, answer aloud and the voice agent passes your answer back. It cannot approve or deny permission requests: it tells you one is waiting, and you decide in the app.
- **Talking over it only stops its speech.** Interrupt whenever you like. The coding agent keeps working. To stop the coding agent, say so, or press **Stop** in the thread.
- **It can change threads.** Ask it to start a new thread, or to switch to another thread in the same project. The app follows.
- **It knows your project's instructions.** The voice agent receives the project's `AGENTS.md` and `CLAUDE.md`, so it uses your project's names and rules. The coding agent still loads them itself.
- **What you say is not saved.** What the voice agent says is shown as captions, which are gone when the session ends. Your own words are not shown. Only the requests sent to the coding agent become part of the thread.

## Where your audio goes

Microphone audio travels over your authenticated connection to the environment, and from there to the endpoint you confirmed. T3 Code never switches to another endpoint by itself, and it stores neither the audio nor the captions. What the endpoint's provider keeps is up to that provider.

The endpoint also receives the text the voice agent works with: the project's instruction files, the project's and the threads' titles, and what the coding agent replies and asks, which the voice agent summarises for you. Your confirmation covers every project on that environment that uses the same endpoint.

## Good to know

- Voice mode is a pilot. It has been tested against a simulated endpoint only, not yet against a real realtime model or gateway, so expect rough edges with yours and tell us what you see.
- Use headphones if the voice agent keeps interrupting itself. Echo cancellation is on, but loud speakers can still reach the microphone.
- Voice mode never gets more access than you gave it when it started. It stays within the narrowest permissions and plan mode of the draft or threads it has been in: it starts new threads with the same restrictions and will not switch to a thread with broader access. If you give a thread broader access while voice mode is on, voice mode stops acting in it. End voice mode and start it again on that thread instead.
- If you start voice mode on a new draft and then type and send the draft's first message yourself, voice mode ends. Start it again to talk to that thread.
- Voice mode and dictation share the microphone. While one is active the other is unavailable.
- Voice mode uses the microphone priority from **Settings → Voice**.
- A session ends by itself after 5 minutes in which nobody speaks and the coding agent is not working, and after 30 minutes in any case. Start it again to continue.
- If the connection drops, or someone changes the voice endpoint in Settings, the session ends. Work the coding agent has started continues in the thread.
- In a browser, voice mode needs **HTTPS** or `localhost`. For a plain-HTTP remote server, use the desktop app.
- The endpoint's provider bills voice mode to the key you configured.
- A [managed policy](./managed-policy.md) that restricts providers also turns off voice mode.
