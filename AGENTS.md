# Working on this installation

Read `README.md` first. This repository holds the code for a small local service that runs on the user's own Linux machine and keeps it reachable from the workspace.

- The product is Node.js and Bash only. Do not add Python, browser-extension, WebRTC, desktop automation, or alternate transport implementations.
- Keep the local service loopback-only, authenticate every run, and preserve Host checks.
- Preserve caller-generated job IDs, SQLite run claims, the pinned machine key, pending results, and duplicate-result caching. A lost connection must not run a job twice, even if the first run's result is unknown.
- Keep the installation under `$HOME/cloud-browser-bridge-v2` to preserve compatibility with existing machine keys. Keep credentials, private URLs, databases, logs, and generated runtime files in ignored `.state/` and `.runtime/` directories.
- The outbound client connects to `https://workspace.brinked.ai`. TLS verification must remain enabled. Machines register automatically with locally generated, machine-scoped credentials; no manual setup is required.
- The default five-minute install link carries no provider credentials and installs only the daemon. The separate coding CLI bootstrap is opt-in and uses an encrypted credential transfer. Never print either link capability or provider credentials. A GET returns only a launcher; only its POST consumes the capability.
- Keep documentation aligned with the one supported implementation and transport.
