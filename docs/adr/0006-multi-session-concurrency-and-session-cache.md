# Multi-Session Concurrency, Session Cache, and Recency Ordering

## Context

Previously, the plugin managed a single global streaming state (`isStreaming`) and a single static `Process` component. When a Hermes Session was actively generating, switching to any other session locked the input bar with a Stop button, prevented sending new messages, and caused in-flight tool progress and thinking indicators to leak into other session views. Furthermore, switching sessions asynchronously loaded messages over stdio, causing visual flickers, layout recalculation jumps, and lost scroll positions.

External updates arriving from background sources (cron jobs, TUI sessions, or CLI scripts) were not dynamically reflected in the active view or sorted to the top.

## Decision

1. **Independent Per-Session Concurrency**:
   - Transition from a single static streaming process to dynamic, per-session subprocesses.
   - Maintain an in-memory map of in-flight session streams (`activeStreams[sessionId] = { proc, streamingContent, toolEvents }`).
   - The input bar's Send/Stop state is strictly scoped to the currently selected session. If Session A is generating, it shows a Stop button; switching to idle Session B shows a Send button and allows submitting a parallel request.

2. **Client-Generated Session IDs**:
   - When dispatching a prompt from a new session, the plugin generates a unique session ID (`api-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`) and passes it in the `X-Hermes-Session-Id` request header. This guarantees every session stream has a known, non-empty session ID from initiation, eliminating leaky falsy-ID fallbacks.

3. **In-Memory Session Cache**:
   - Maintain a local client-side cache (`sessionCache[sessionId] = { messages, title, ... }`).
   - When switching sessions, the cached messages mount instantaneously (0ms blank delay), and the viewport immediately clamps to the bottom without scrolling animation, preventing visual layout jumping.
   - Background revalidation queries `get-session` to reconcile any external turns without destroying local view stability.

4. **Dynamic Recency Ordering & Animated Displacement**:
   - Sessions are sorted by their most recent activity (`updated_at` or in-flight turn).
   - When a session receives a local turn or external update, it moves to the top of the Session List with a fluid vertical sliding animation using QML `ListView.displaced`.

5. **Smart Polling & Direct IPC Signal**:
   - Fast background polling (3 seconds) runs while the flyout is open; regular interval polling runs when closed.
   - An IPC endpoint (`syncSession <sessionId>`) allows external tools (cron, TUI) to signal the plugin immediately upon completion.
