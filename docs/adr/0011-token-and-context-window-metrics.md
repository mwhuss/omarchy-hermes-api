# Token Usage and Context Window Metrics

> **Status**: Accepted

## Context

Conversational sessions with large language models have finite context windows. Previously, `bin/hermes-bridge.js` discarded LLM token usage metadata returned in Server-Sent Events (SSE) completion events. As conversations progressed across multiple turns, users had no visibility into prompt or completion token consumption or whether a conversation was approaching model context boundaries.

## Decision

1. **SSE Wire Protocol Parsing**:
   - The Bridge Subprocess (`bin/hermes-bridge.js`) sends `stream_options: { include_usage: true }` in chat completion requests.
   - The SSE parser extracts the `usage` object (`prompt_tokens`, `completion_tokens`, `total_tokens`) from the stream chunks or final completion chunk before `[DONE]`.
   - Token counts are validated defensively (non-negative integers, computing `total_tokens` from `prompt_tokens + completion_tokens` if omitted) and forwarded in the `done` event payload: `{ type: "done", ..., usage: { prompt_tokens, completion_tokens, total_tokens } }`.

2. **Session and Message Turn Storage**:
   - In `Widget.qml`, incoming `ev.usage` is recorded on the assistant turn (`modelData.usage`) and aggregated into the session cache metadata (`cached.last_usage` and `cached.total_tokens`).

3. **UI Metrics & Context Window Thresholds**:
   - In Settings View, an optional integer field (`Context Window`) allows users to specify the context window ceiling (in tokens) for each endpoint and agent profile.
   - When a context window ceiling is configured, the Session Header displays the utilization ratio and percentage: `${formatTokenCount(tokens)}/${formatTokenCount(ceiling)} (${percent}%)` (e.g. `17.1k/96k (18%)`).
   - Warning and alert thresholds adapt dynamically to the percentage consumed (amber warning at $\ge 70\%$, alert red with `⚠️` at $\ge 90\%$).
   - If no ceiling is configured, it displays the total tokens with no label: `${formatTokenCount(tokens)}` (e.g. `17.1k`) with fixed thresholds ($\ge 64\text{k}$ warning, $\ge 100\text{k}$ alert).
   - For assistant message turns, a compact badge (`formatTokens(count)`) is rendered next to the timestamp.

## Consequences

- End users have clear, immediate visibility into token expenditure and context window consumption without manual command-line inspection.
- The interface renders intuitive utilization ratios and percentages when limits are configured, while falling back gracefully when limits are unconfigured.
- Zero extra dependencies are introduced; parsing relies purely on Node native streams and QML declarative bindings.
