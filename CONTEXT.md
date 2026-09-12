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
A standalone Node.js CLI helper process spawned by Quickshell via stdio to execute OpenAI-compatible HTTP requests and stream structured events with zero third-party dependencies.
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
The configured display identity for the Hermes Agent instance (defaulting to "Hermes"), resolved via `HERMES_API_SERVER_NAME` in the environment or `~/.hermes/.env`. Displayed across the flyout header, conversational greetings, and desktop notifications.
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

**Hermes Endpoint**:
A configured network target (URL, port, API key, display name) running an instance of the Hermes Agent API.
_Avoid_: Host, server instance, backend URL

**Agent Profile**:
A named persona or operational scope within a Hermes Endpoint with its own route and credentials. Each Hermes Endpoint possesses an inherent default Agent Profile representing the endpoint's base `hermes-agent` and credentials, which is rendered ornamentally in the Settings View and is never saved to the Endpoint Configuration File.
_Avoid_: Bot persona, flavor, agent role

**Settings View**:
The overlay configuration interface within the Omarchy Plugin where Hermes Endpoints and Agent Profiles are managed.
_Avoid_: Preferences dialog, config window, options panel

**Endpoint Configuration File**:
The permission-restricted (`0600`) JSON file storing persistent Hermes Endpoints and Agent Profiles at `~/.config/omarchy-hermes-api/settings.json`.
_Avoid_: Dotfile, plugin config, shell JSON
**Agent Target**:
A specific selectable destination pairing a Hermes Endpoint and an Agent Profile (or its default profile) for chat execution and session scoping.
_Avoid_: Agent destination, route target, bot instance

**Agent Picker**:
An interactive selector allowing the user to designate the destination Agent Target when initiating a new Hermes Session or switching conversation context.
_Avoid_: Bot selector, profile chooser, model picker

