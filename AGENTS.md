# Working on this bridge

Read `README.md` first. This repository is an explicitly authorized command channel into the user's own Linux machine.

- The product is Node.js and Bash only. Do not add Python, browser-extension, WebRTC, desktop automation, or alternate transport implementations.
- Keep the HTTP agent loopback-only, authenticate every execution, and preserve Host checks.
- Preserve durable caller-generated job IDs, SQLite execution claims, pinned ledger identity, pending results, and duplicate-result caching. A lost connection must not repeat a completed or uncertain side effect.
- Keep the installation under `$HOME/cloud-browser-bridge-v2` to preserve compatibility with existing Node identities. Keep credentials, private URLs, databases, logs, and generated runtime files in ignored `.state/` and `.runtime/` directories.
- The worker connects outbound to `https://workspace.brinked.ai`. TLS verification must remain enabled.
- The default five-minute install link carries no provider credentials and installs only the bridge. The separate coding-agent bootstrap is opt-in and uses an encrypted credential transfer. Never print either link capability or provider credentials. A GET returns only a launcher; only its POST consumes the capability.
- Keep documentation aligned with the one supported implementation and transport.
