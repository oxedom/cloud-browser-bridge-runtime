# Cloud Browser Bridge: runtime files

Public, dependency-free runtime files for installing the Cloud Browser Bridge on an authorized Linux machine. The Cloud Browser Bridge is a small background service that keeps this machine reachable from the workspace and runs scheduled jobs through a local authenticated service. Development, workspace deployment, administrator configuration, and private state live in a separate private repository.

The daemon checks in with `https://workspace.brinked.ai` over HTTPS, runs each job locally, and returns stdout, stderr, and exit status.

```text
webpage or CLI -> the workspace <- daemon -> local service -> bash
```

## Install

The target needs Linux, Bash, curl, tar, `sha256sum`, and `flock`. The installer uses a compatible system Node.js or downloads a checksum-verified Node.js runtime privately.

```bash
curl -fsSL https://raw.githubusercontent.com/oxedom/cloud-browser-bridge-runtime/main/install.sh | bash
```

The installation lives at `$HOME/cloud-browser-bridge-v2` to avoid colliding with an older installation's machine key or job log.

```bash
~/cloud-browser-bridge-v2/bridge status
~/cloud-browser-bridge-v2/bridge run 'hostname; whoami'
~/cloud-browser-bridge-v2/bridge run 'pwd; ls' --cwd /
~/cloud-browser-bridge-v2/bridge result ORIGINAL_JOB_ID --json
~/cloud-browser-bridge-v2/bridge setup
~/cloud-browser-bridge-v2/bridge stop
```

Each job has a caller-generated stable ID, a 60-second limit, and a combined 1 MiB output limit. SQLite records the run claim before the job starts and caches its result, so a redelivery returns the cached result instead of running the job twice. An interrupted claim is reported instead of replayed.

Private state lives in `.state/` and `.runtime/`. The machine key is the locally generated machine credential and the job log is the local record of every run. Preserve them together. Never commit credentials, private links, databases, or logs.
