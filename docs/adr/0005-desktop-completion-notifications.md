# Desktop Completion Notifications

Hermes agent generations and tool executions can take significant time to complete. To enable asynchronous multi-session workflows where the user is working in another app or browsing a different chat session, the widget dispatches native desktop notifications via `omarchy-notification-send` (falling back to `notify-send`) upon response completion or error.

Notifications follow session-aware visibility rules:
1. If the chat flyout is hidden (user is working on another desktop app), notifications are shown.
2. If the chat flyout is open and the responding session is currently selected, notifications are suppressed since the user is actively watching the response stream.
3. If the chat flyout is open and any other session is selected, notifications are shown so the user is alerted that background generation finished.

Clicking the notification triggers Quickshell IPC `openSession <sessionId>`, which opens the flyout window and immediately selects and loads that session.
