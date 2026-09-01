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
