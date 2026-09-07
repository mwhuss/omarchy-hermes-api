# Omarchy Hermes API Plugin Context

The Omarchy Hermes API Menu Bar Plugin provides a native desktop bar interface to manage and interact with Hermes Agent sessions through the Hermes API server.

## Language

**Omarchy Plugin**:
An interactive UI component for the Omarchy Linux desktop shell bar, built with Quickshell (QML/Qt).
_Avoid_: Extension, applet, widget-only

**Hermes Session**:
A persistent, multi-turn conversational thread and execution state maintained by the Hermes Agent API server.
_Avoid_: Chat, thread, conversation

**Bridge Subprocess**:
A bundled Node.js CLI helper process spawned by Quickshell via stdio to execute OpenAI SDK requests and stream structured events.
_Avoid_: Daemon, backend server, microservice

**Tool Progress Event**:
A real-time status event emitted during agent generation reflecting tool invocation (e.g. shell command, file write, web search).
_Avoid_: System log, debug output, notification

**Prompt History**:
The chronological, navigable sequence of user prompts submitted within a specific Hermes Session.
_Avoid_: Prompt stack, command history, shell history

**Prompt Draft**:
Unsubmitted text typed into the prompt input field, temporarily retained in memory while cycling through Prompt History.
_Avoid_: Unsent message, scratchpad, input buffer

**Session Header**:
The control and metadata bar above the chat stream displaying the active Hermes Session's title, model, and session actions.
_Avoid_: Title bar, top bar, chat header

**Session List**:
The sidebar navigation area presenting selectable Hermes Sessions with their status indicators.
_Avoid_: Session drawer, thread list, history sidebar

**Server Name**:
The configured display identity for the Hermes Agent instance (defaulting to "Hermes"), resolved via `HERMES_API_SERVER_NAME` in the environment or `~/.hermes/.env`. Displayed across the flyout header, status bar tooltip, conversational greetings, and desktop notifications.
_Avoid_: Agent title, bot alias, profile tag

**In-Flight Session Stream**:
The active generation lifecycle and real-time streaming state (thinking indicator, tool progress, and token buffer) scoped independently to a single Hermes Session.
_Avoid_: Global stream, background task, active request

**Session Cache**:
The client-side in-memory cache of Hermes Session message histories and view states, enabling instantaneous session switching without network round-trip flickers.
_Avoid_: Local storage, message buffer, memory store

**Session Recency Ordering**:
The dynamic sorting of the Session List where the most recently active Hermes Session (whether from local user submissions, assistant turns, or external sources) is positioned at the top.
_Avoid_: Sorting by date, list shuffle, chronological view

