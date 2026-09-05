# Dependency Management and Lockfile Pinning for Security

Instead of distributing an opaque bundled binary or minified bundle, the plugin maintains an explicit `package.json` specifying the official `openai` SDK with a controlled major version range (`^7.10.0`). Exact dependency versions and integrity hashes are locked via `package-lock.json`. This enables transparent security auditing, allows non-breaking patch and security updates within the 7.x major line, and prevents unexpected breaking changes or supply-chain surprises.
