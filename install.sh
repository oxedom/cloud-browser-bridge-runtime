#!/usr/bin/env bash
set -euo pipefail
umask 077
for tool in curl tar sha256sum flock; do
  command -v "$tool" >/dev/null || { echo "$tool is required." >&2; exit 1; }
done
[[ "$(uname -s)" == Linux ]] || { echo 'Only Linux is supported.' >&2; exit 1; }
bridge_root="$HOME/cloud-browser-bridge-v2"
[[ ! -e "$bridge_root/.git" ]] || { echo 'Existing Git checkout preserved. Run node bridge.mjs install there.' >&2; exit 1; }
mkdir -p "$bridge_root/.state" "$bridge_root/.runtime"
chmod 700 "$bridge_root/.state" "$bridge_root/.runtime"
exec 9>"$bridge_root/.state/source-install.lock"
flock -x 9
stage=$(mktemp -d "$bridge_root/.runtime/install.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
node_bin=$(command -v node || true)
compatible() {
  [[ -n "$1" ]] && "$1" --input-type=module -e 'import http from "node:http";import tls from "node:tls";import {DatabaseSync} from "node:sqlite";if(!http.setGlobalProxyFromEnv||!tls.setDefaultCACertificates||!DatabaseSync)process.exit(1)' >/dev/null 2>&1
}
if ! compatible "$node_bin"; then
  version=v24.22.3
  case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'Unsupported Node architecture.' >&2; exit 1;; esac
  asset="node-$version-linux-$arch.tar.gz"
  distribution="$bridge_root/.runtime/node-$version-linux-$arch"
  node_bin="$distribution/bin/node"
  if ! compatible "$node_bin"; then
    echo "Downloading official Node.js $version..."
    curl -fsSL --retry 3 "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$stage/sums"
    curl -fsSL --retry 3 "https://nodejs.org/dist/$version/$asset" -o "$stage/$asset"
    awk -v name="$asset" '$2==name {print; found=1} END {if(!found)exit 1}' "$stage/sums" > "$stage/expected"
    (cd "$stage" && sha256sum -c expected)
    tar -xzf "$stage/$asset" -C "$stage"
    [[ ! -e "$distribution" ]] || mv "$distribution" "$distribution.incomplete.$RANDOM"
    mv "$stage/node-$version-linux-$arch" "$distribution"
  fi
fi
compatible "$node_bin" || { echo 'Node cannot run on this machine (Linux glibc 2.28+ is required).' >&2; exit 1; }
echo 'Downloading bridge source...'
curl -fsSL --retry 3 https://github.com/oxedom/cloud-browser-bridge-runtime/archive/refs/heads/main.tar.gz -o "$stage/source.tar.gz"
prefix=$(tar -tzf "$stage/source.tar.gz" | sed -n '1s|/.*||p')
[[ "$prefix" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'Invalid source archive.' >&2; exit 1; }
files=(common.mjs agent.mjs bridge.mjs coding.mjs README.md PROMPT.md AGENTS.md package.json)
for file in "${files[@]}"; do
  tar -xOzf "$stage/source.tar.gz" "$prefix/$file" > "$stage/$file"
  [[ -s "$stage/$file" ]] || { echo 'Incomplete source archive.' >&2; exit 1; }
done
for file in "$stage"/*.mjs; do "$node_bin" --check "$file"; done
for file in "${files[@]}"; do
  cp "$stage/$file" "$bridge_root/$file.install-tmp"
  mv "$bridge_root/$file.install-tmp" "$bridge_root/$file"
done
printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$node_bin" "$bridge_root/bridge.mjs" > "$bridge_root/bridge.install-tmp"
chmod 700 "$bridge_root/bridge.install-tmp"
mv "$bridge_root/bridge.install-tmp" "$bridge_root/bridge"
flock -u 9
exec 9>&-
"$node_bin" "$bridge_root/bridge.mjs" install "$@"
