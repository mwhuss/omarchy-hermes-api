# Pinned NPM Dependency Management for Security

Instead of distributing an opaque bundled binary or minified bundle, the plugin maintains an explicit `package.json` with an exact pinned version of the official `openai` package (e.g. `4.86.1` / `4.x`). This enables transparent security auditing, allows users to inspect dependencies directly before running `npm install`, and prevents supply-chain surprises from floating version ranges.
