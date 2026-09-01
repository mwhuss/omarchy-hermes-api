# Configuration Hierarchy and Auto-Discovery

To support zero-configuration usage for local Hermes installations while allowing flexible port and host overrides, the plugin resolves connection parameters in order of priority: explicitly defined environment variables (`HERMES_API_SERVER_URL`, `HERMES_API_SERVER_KEY`, `HERMES_API_SERVER_PORT`), falling back to parsing `~/.hermes/.env`, and lastly defaulting to `http://127.0.0.1:8642/v1`.
