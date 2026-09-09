# Dependency Management and Lockfile Pinning for Security

Instead of distributing an opaque bundled binary or minified bundle, the plugin maintains an explicit `package.json` specifying the official `openai` SDK with an exact pinned version (`7.10.0`). Exact dependency versions and integrity hashes are locked via `package-lock.json` and installed via `npm ci --omit=dev`. This enables transparent security auditing, ensures reproducible builds, and prevents unexpected breaking changes or supply-chain surprises.
