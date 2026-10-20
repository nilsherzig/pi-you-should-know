# Pi You Should Know

A background observer for Pi, using the [observer prompt extracted from Claude Code 2.1.292](https://github.com/wassname/cc-plugin-you-should-know). It looks for one consequential detail the user may have missed and normally answers `learn: none`.

<img width="1242" height="160" alt="image" src="https://github.com/user-attachments/assets/3eb8563b-a665-48a3-9510-d793d8e51847" />

## Installation

Install directly from GitHub; no npm publication is required:

```sh
pi install git:github.com/nilsherzig/pi-you-should-know
```

Run `/reload` in an existing Pi session. Update with `pi update git:github.com/nilsherzig/pi-you-should-know`.

For local development, use a local package instead of the GitHub source:

```sh
git clone https://github.com/nilsherzig/pi-you-should-know.git
cd pi-you-should-know
npm ci
pi install "$PWD"
```

If the GitHub source is already installed, first remove it with `pi remove git:github.com/nilsherzig/pi-you-should-know` to avoid loading both copies. Pi loads local package files directly: edit them and run `/reload`, without pushing, publishing, or reinstalling.

## Behavior

Automatic checks run every six main-agent turns in terminal UI mode, using the current model and reasoning level. Providers registered with their own stream function are skipped: they can rewrite the request after the observer captures it, so the captured payload is not a reusable cache prefix. The xAI OAuth provider is the exception. Its custom stream only sets request headers, and its body rewrite runs in `before_provider_request`, which the observer captures and reuses. They do not wait in Pi's turn handler or block the main run. Only one check runs at a time. Requests are cancelled on session shutdown/replacement, tree navigation, a new user run, model/reasoning changes, or compaction; a five-minute timeout bounds each request.

Suggestions remain in the footer below the normal session statistics, outside model context, until handled with `/ysk know`, `/ysk dismiss`, `/ysk chat`, or `/ysk off`. They remain visible across new chat messages and session reloads. `/ysk more` opens the explanation above the editor. The extension remembers the last 50 offered/understood topics on the current session branch. Repeated dismissals reduce check frequency. Suggestions and their explanations are persisted as custom session data, not conversation messages.

## Commands

- `/ysk demo` — show a clearly marked sample suggestion without a model request or token costs. Try `/ysk more` and `/ysk dismiss` to preview the normal interaction. The demo is transient, does not change topic history or check frequency, and never replaces a real suggestion or running check.
- `/ysk more` — show the existing explanation without another model request.
- `/ysk know` — mark the topic understood and close the suggestion.
- `/ysk dismiss` — dismiss and reduce frequency after repeated dismissals.
- `/ysk chat` — put the note into the editor for discussion; never overwrite a draft or submit automatically.
- `/ysk check` — start a non-blocking check with start and completion notifications, including when nothing is found. If a check is already running, subscribe to its completion without another request. If a check cannot start, explain why.
- `/ysk off` / `/ysk on` — disable/enable checks for this session.
- `/ysk status` — show readiness, running elapsed time, or the latest result with duration, completion time, and token usage. Completed results are restored from the current session branch after reload.

A main-chat request must have been observed since session load/reload. Loading an old conversation does not restore the actual provider request settings; `/ysk check` explains that a normal chat message is needed first instead of constructing a potentially uncached request from guesses. An open suggestion must be understood or dismissed before another check can start.

Findings are always shown in the footer, independently of debug mode. Routine diagnostic status such as waiting, checking, or nothing found is hidden by default. Enable those diagnostics explicitly when starting Pi:

```sh
PI_YSK_DEBUG=1 pi
```

This shows readiness, running checks, and their outcomes. Manual notifications, suggestions, and cache/error warnings do not require debug mode. Automatic checks do not produce routine start/completion notifications unless a manual check subscribed to the running request.

## Prompt caching and costs

The observer preserves Pi's model-facing transcript, including system messages, tool declarations, images, thinking signatures, tool calls, and tool results. It appends the observer instructions and topic history as one final user message. It does not replace the system prompt, serialize the conversation, truncate a rolling window, or add its output to the main chat.

Requests use the main session's model, reasoning level, and session ID. Before dispatch, the extension inherits the actual main provider request's generation and cache settings, including its output budget, reasoning parameters, tools, system instructions, and cache key. There is no small observer-specific output limit. The main transcript must still match the main request's prefix after provider conversion; otherwise dispatch is blocked and Pi shows an error. Anthropic's existing cache boundary is retained alongside the observer request's final marker.

Tool declarations remain present to preserve the cache prefix, but the observer has no execution loop: any returned tool calls are never executed.

Pi renders an **error notification** if the reported main-chat cache-hit rate is below 70%, even when the observer suggests nothing:

```text
input = uncached_input + cache_read + reported_cache_write
observer_estimate = Pi.estimateTokens(appended_observer_message)
main_input_estimate = max(cache_read, input - observer_estimate)
hit_rate = cache_read / main_input_estimate
```

A zero denominator is treated as no reported hit. Cache writes are not hits; zero or missing write metrics do not invalidate reported reads. The error includes total input, cached input, estimated observer/main-chat sizes, and output tokens. Reasoning tokens are already included in Pi's output count. The suffix estimate uses Pi's built-in estimator, not a provider-specific tokenizer.

Caching still depends on provider support, cache lifetime, and minimum prefix size. The observer suffix and newly generated main-agent content may incur uncached input costs. Check results, cancellation/error outcomes, provider/model, original manual/automatic trigger, timing, and any reported usage with its observer-token estimate are saved in `you-should-know-usage` custom entries in Pi's normal session files. The `usage` object includes uncached input, cache reads/writes, output, and the per-category and total USD cost estimates in `usage.cost`. `/ysk status` exposes the latest result and its estimated cost. These custom entries do not add usage to Pi's main-agent totals.

There is no separate state directory. To inspect the estimated observer cost in one session file:

> Can you notice that during the early development there used to be one? LLMs suck at updating docs ffs. 

```sh
jq -s '[.[] | select(.type == "custom" and .customType == "you-should-know-usage") | .data.usage.cost.total // 0] | add // 0' SESSION.jsonl
```

Costs are Pi's model-pricing estimates, not provider invoices or subscription charges. Zero estimates can reflect missing pricing information.

## Tests

Tested against Pi 1.3.0. For development, install Node.js 22.19 or newer and run from this repository:

```sh
npm ci
npm test
```

The explicit `pi.extensions` manifest loads only the extension entry point, not tests or test helpers. Pi supplies the runtime APIs; pinned development dependencies support reproducible tests without requiring a Pi CLI installation.

Tests use the real Anthropic and OpenAI request converters, stopping before network dispatch, to compare main/observer system instructions, tools, reasoning, budgets, transcript prefixes, cache keys, and cache markers. Factory tests cover non-blocking execution, cancellation/timeouts, single-flight requests, manual feedback, reload/readiness reporting, persistent footer findings, debug-only diagnostics, session cost records, topic persistence, cache warnings, missing write metrics, and draft protection. No paid provider requests are made by tests.

## Attribution and licensing

The extension implementation, tests, and documentation are MIT-licensed. The bundled observer prompt is third-party material extracted from Anthropic Claude Code 2.1.292 and shared by [wassname/cc-plugin-you-should-know](https://github.com/wassname/cc-plugin-you-should-know). Its source repository does not include an explicit prompt license; the implementation's MIT license does not relicense that prompt. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

> Anthropic complaining about copyright 🤡🤡🤡
