# Zero-Dependency Bridge Subprocess with Native Fetch and SSE

> **Status**: Accepted (supersedes [ADR-0003](./0003-pinned-npm-dependencies.md))

To eliminate installation friction for end users adding the plugin to Omarchy Shell (`omarchy plugin add`), the Bridge Subprocess eliminates third-party npm dependencies entirely. Rather than relying on the `openai` npm package or pre-bundling minified artifacts with `esbuild`/`ncc`, the bridge communicates with Hermes API endpoints using Node.js 18+ native `fetch` and a streaming Server-Sent Events (SSE) line buffer. Inactivity timeouts reset on each streamed chunk to accommodate long multi-tool generation turns while detecting connection stalls, and the bridge enforces an early Node version guard (`>=18.0.0`). This achieves zero post-clone setup steps, eliminates supply-chain exposure, and preserves human-readable source code for desktop security audits.
