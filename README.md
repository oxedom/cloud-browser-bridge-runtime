# Cloud Browser Bridge Runtime

Public, dependency-free runtime files for installing the Cloud Browser Bridge on an authorized Linux machine. Development, relay deployment, controller configuration, and private state live in a separate private repository.

The target connects outbound to `https://workspace.brinked.ai`, polls for commands, executes them through an authenticated loopback agent, and returns stdout, stderr, and exit status.

```text
webpage or CLI -> durable relay <- outbound worker -> loopback agent -> bash
```

## Install

The target needs Linux, Bash, curl, tar, `sha256sum`, and `flock`. The installer uses a compatible system Node.js or downloads a checksum-verified Node.js runtime privately.

```bash
curl -fsSL https://raw.githubusercontent.com/oxedom/cloud-browser-bridge-runtime/main/install.sh | bash
```

The installation lives at `$HOME/cloud-browser-bridge-v2` to avoid colliding with older installations and ledgers.

```bash
~/cloud-browser-bridge-v2/bridge status
~/cloud-browser-bridge-v2/bridge run 'hostname; whoami'
~/cloud-browser-bridge-v2/bridge run 'pwd; ls' --cwd /
~/cloud-browser-bridge-v2/bridge result ORIGINAL_JOB_ID --json
~/cloud-browser-bridge-v2/bridge setup
~/cloud-browser-bridge-v2/bridge stop
```

Each command has a durable caller-generated ID, a 60-second limit, and a combined 1 MiB output limit. SQLite records the execution claim before starting a command and caches its result. Redelivery returns the cached result; an interrupted claim is reported instead of replayed.

Private state lives in `.state/` and `.runtime/`. Preserve the identity and execution ledger together. Never commit credentials, private links, databases, or logs.
