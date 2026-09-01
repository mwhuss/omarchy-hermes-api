# Subprocess Bridge for Quickshell QML and Node.js OpenAI SDK

Quickshell runs on a Qt/QML JavaScript engine (QJSEngine) without native Node.js package support. We decided to implement the client as a bundled Node.js CLI script using the `openai` SDK, executed on-demand via `Quickshell.Io.Process` and communicating through structured newline-delimited JSON (NDJSON) over standard I/O. This provides clean encapsulation of npm dependencies and streaming responses without managing a persistent background daemon.
