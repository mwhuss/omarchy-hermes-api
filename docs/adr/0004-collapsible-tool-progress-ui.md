# Collapsible Tool Progress UI

During multi-step agent reasoning, Hermes emits `hermes.tool.progress` events (terminal execution, web searches, file edits). Rather than dumping raw console output directly into the chat transcript, the QML UI presents these as interactive, collapsible status badges. This maintains a clean reading experience for the main conversation while allowing full inspection of tool payloads on demand.
