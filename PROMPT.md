# Inspect and repair the owner's installation

The native installer attempted to deploy this installation on the owner's authorized machine. Read `AGENTS.md` and `README.md`, inspect the installation, repair failures within the user's permissions, and verify job execution through `https://workspace.brinked.ai`.

Keep the installation under `$HOME/cloud-browser-bridge-v2`. Preserve `.state`, the job log, and the machine key. Start or repair it with `node bridge.mjs setup`, then test `node bridge.mjs run 'hostname; whoami'`. Also verify separate stdout/stderr and a nonzero exit code. Leave the services running.

Keep authentication material and private links out of commands, summaries, and logs. Do not redeploy Cloudflare, request administrator credentials, disable TLS verification, change network policy, or replace a missing job log under an old machine key. Report only verification that actually succeeded.
