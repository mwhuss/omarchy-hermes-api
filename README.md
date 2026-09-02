# Omarchy Hermes API Plugin

A native [Omarchy](https://github.com/omarchy) menu bar plugin and flyout interface for interacting with [Hermes Agent](https://github.com/NousResearch/Hermes-Function-Calling) sessions via the Hermes API server.

Built with [Quickshell](https://quickshell.outfoxxed.me/) (QML) and a lightweight Node.js stdio bridge.

---

## ✨ Features

- **Status Bar Integration**: Live connection health indicator, activity badge, and one-click flyout popup in your Omarchy bar.
- **Real-Time Streaming**: Low-latency token-by-token assistant response streaming powered by official OpenAI-compatible SSE endpoints.
- **Rich Tool Execution Cards**: Live collapsible badges tracking agent tool calls (`hermes.tool.progress`), displaying terminal executions, file modifications, web searches, and JSON tool results.
- **Session Management**:
  - Browse, switch, and search conversational sessions.
  - Inline session renaming.
  - Safe two-step session deletion with auto-canceling safety timer.
  - Automatic loading of the most recent active session.
- **Rich Markdown Chat**: Formatted Markdown rendering in assistant responses with clickable links and syntax styling.
- **Custom System Prompts**: Expandable per-session system prompt configuration directly from the empty chat view.
- **Desktop Completion Notifications**: Interactive desktop notifications dispatched when Hermes finishes a response or encounters an error, featuring click-to-open IPC action to reopen the chat flyout.
- **Zero-Config Auto-Discovery**: Automatically discovers local Hermes Agent server credentials from environment variables or `~/.hermes/.env`.

---

## 📋 Prerequisites

- **Linux** running **Omarchy Desktop** with **Quickshell**
- **Node.js** (v18.0.0 or newer) and **npm**
- A running **Hermes Agent API server** (e.g. `hermes serve` listening on port `8642` or custom URL)

---

## 🚀 Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/mwhuss/omarchy-hermes-api.git
   cd omarchy-hermes-api
   ```

2. **Install dependencies and register plugin:**
   ```bash
   npm install
   npm run install-plugin
   ```
   *(This installs pinned dependencies and symlinks the plugin to `~/.config/omarchy/plugins/com.mwhuss.omarchy-hermes-api`.)*

3. **Enable the plugin in Omarchy Shell:**
   Add `"com.mwhuss.omarchy-hermes-api"` to your bar layout in `~/.config/omarchy/shell.json`:
   ```json
   {
     "bar": {
       "sections": {
         "right": [
           "com.mwhuss.omarchy-hermes-api",
           "..."
         ]
       }
     }
   }
   ```

4. **Restart Omarchy Shell** or reload your bar widgets to load the plugin.

---

## ⚙️ Configuration

The bridge automatically discovers server configuration in the following order of priority:

1. **Environment Variables**:
   - `HERMES_API_SERVER_URL` (e.g. `http://127.0.0.1:8642`)
   - `HERMES_API_SERVER_KEY` (API authentication key)
   - `HERMES_API_SERVER_PORT` (Port override, defaults to `8642`)

2. **Local Hermes Config File (`~/.hermes/.env`)**:
   - `API_SERVER_URL`
   - `API_SERVER_KEY`
   - `API_SERVER_PORT` or `PORT`

3. **Default Fallback**:
   - URL: `http://127.0.0.1:8642/v1`
   - Key: `dummy-key` (standard for local unauthenticated servers)

---

## 🧪 Testing

Run the automated bridge integration test suite against your running Hermes API server:

```bash
npm test
```

This verifies:
- Manifest schema validation & default settings
- Server connection & status check (`status`)
- Session listing & normalization (`list-sessions`)
- Session detail & message fetching (`get-session`)
- Inline session renaming (`rename-session`)
- Live NDJSON chat streaming (`stream-chat`)
- Chat streaming with desktop completion notifications (`--notify`)

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Omarchy Bar (QML)                    │
│                      (Widget.qml)                       │
└───────────────────────────┬─────────────────────────────┘
                            │
               stdio (NDJSON streaming IPC)
                            │
┌───────────────────────────▼─────────────────────────────┐
│               Node.js Subprocess Bridge                 │
│                 (bin/hermes-bridge.js)                  │
└───────────────────────────┬─────────────────────────────┘
                            │
              REST / OpenAI SSE Protocol
                            │
┌───────────────────────────▼─────────────────────────────┐
│                 Hermes Agent API Server                 │
│                 (http://127.0.0.1:8642)                 │
└─────────────────────────────────────────────────────────┘
```

For detailed architectural decision records, see [`docs/adr/`](docs/adr/).

---

## 📄 License

[MIT](LICENSE)
