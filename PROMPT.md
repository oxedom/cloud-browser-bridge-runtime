# Inspect and repair the owner's bridge

The native installer attempted to deploy this bridge on the owner's authorized machine. Read `AGENTS.md` and `README.md`, inspect the installation, repair failures within the user's permissions, and verify commands through `https://workspace.brinked.ai`.

Keep the installation under `$HOME/cloud-browser-bridge-v2`. Preserve `.state`, the execution ledger, and the machine identity. Start or repair it with `node bridge.mjs setup`, then test `node bridge.mjs run 'hostname; whoami'`. Also verify separate stdout/stderr and a nonzero exit code. Leave the agent and worker running.

Keep authentication material and private links out of commands, summaries, and logs. Do not redeploy Cloudflare, request administrator credentials, disable TLS verification, change network policy, or replace a missing ledger under an old identity. Report only verification that actually succeeded.
