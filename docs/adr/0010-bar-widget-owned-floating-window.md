# Bar-Widget-Owned Floating Window for Standalone App Interface

> **Status**: Accepted

## Context

Users require Hermes to remain persistently visible alongside editors, terminals, or browsers, or tiled across a dedicated desktop workspace, rather than exclusively operating as a dismissible status bar flyout (`KeyboardPanel`).

First-party Omarchy shell plugins often implement persistent window interfaces via separate `panel`-kind entry points paired with a `service` singleton. However, the `com.mwhuss.omarchy-hermes-api` bar widget is always loaded in the user's status bar and already owns all in-memory state: active Hermes Sessions, Session Cache, prompt drafts, in-flight SSE streams, and the active Node.js Bridge Subprocess. Refactoring this into a separate service singleton would introduce significant synchronization overhead, complexity, and latency across session switching.

## Decision

The App Window is implemented as a `FloatingWindow` child owned directly by the existing bar widget (`Widget.qml`):

1. **Direct State Sharing**: The bar flyout (`KeyboardPanel`) and standalone application window (`FloatingWindow`) share the same inline `Component` definitions (`panelHeader` and `chatBody`), closing over `root` state directly with zero serialization or property-passing overhead.
2. **Mutual Exclusivity**: The flyout and app window are mutually exclusive surfaces gated by Loaders (`root.opened` vs `root.appWindowOpen`). Opening either surface cleanly dismisses the other while preserving session state, prompt drafts, and in-flight SSE stream subprocesses.
3. **Desktop & Window Manager Integration**: The `FloatingWindow` opens at default dimensions (800×650, minimum 560×480) and behaves as a native Wayland toplevel managed by Hyprland (floating, tiling, moving across workspaces). Window close events via the WM button ('X') or `Esc` synchronize visibility back to `root.closeAppWindow()`.
4. **IPC Control**: Quickshell IPC exposes `toggleAppWindow`, allowing single-hotkey toggling via Hyprland keybindings or CLI (`hermes-toggle toggleAppWindow`).

## Consequences

- Direct state sharing beats a multi-process service refactor while keeping `kinds` in `manifest.json` as `["bar-widget"]`.
- The header includes a dedicated button (`\uF2D0`) with `PanelToolTip` to detach into the App Window from the flyout.
- Fast polling (`fastPollTimer`) active-polls while either the flyout or the app window is open.
- Deviances from standard standalone panel precedents are contained within the widget, with verified technical preconditions confirming that a bar widget can own a toplevel `FloatingWindow` in Quickshell without identity collisions or re-mapping defects.
