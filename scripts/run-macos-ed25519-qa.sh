#!/usr/bin/env bash
# Restore the disposable runner's network and trust settings before retaining reports.
set -euo pipefail

[[ $(uname -s) == Darwin && ${GITHUB_ACTIONS:-} == true && ${RUNNER_OS:-} == macOS ]]
[[ ${RUNNER_ENVIRONMENT:-} == github-hosted && ${GITHUB_REPOSITORY:-} == TLBtianhu/Agentrans ]]
[[ ${GITHUB_REF:-} == refs/heads/codex/ed25519-macos-update-20261119 && -z ${AGENTRANS_UPDATE_SIGNING_KEY+x} ]]
[[ ${QA_ARCH:-} == arm64 && ${RUNNER_ARCH:-} == ARM64 || ${QA_ARCH:-} == x64 && ${RUNNER_ARCH:-} == X64 ]]
[[ ${RUNNER_TEMP:-} == /* && -f ${QA_OLD_ZIP:-} && -f ${QA_NEW_ZIP:-} && -f ${QA_NEW_ZIP:-}.sig ]]
[[ ${QA_REPORT_DIR:-} == "$RUNNER_TEMP/"* ]]

umask 077
scratch=$(mktemp -d "$RUNNER_TEMP/agentrans-ed25519-tls.XXXXXX")
hosts=/private/etc/hosts
keychain=/Library/Keychains/System.keychain
root_ca=$scratch/root.pem
trusted=0
hosts_changed=0

flush_hosts() {
  sudo -n /usr/bin/dscacheutil -flushcache
  sudo -n /usr/bin/killall -HUP mDNSResponder
}

cleanup() {
  local status=$? cleanup_error=0
  trap - EXIT
  if (( hosts_changed )); then
    sudo -n /usr/bin/tee "$hosts" <"$scratch/hosts.before" >/dev/null || cleanup_error=1
    flush_hosts || cleanup_error=1
    cmp -s "$scratch/hosts.before" "$hosts" || cleanup_error=1
  fi
  if (( trusted )); then
    sudo -n /usr/bin/security remove-trusted-cert -d "$root_ca" || cleanup_error=1
    sudo -n /usr/bin/security delete-certificate -Z "$fingerprint" "$keychain" || cleanup_error=1
  fi
  /bin/rm -rf -- "$scratch" || cleanup_error=1
  if (( cleanup_error )); then
    echo 'Could not restore the disposable runner fixture settings' >&2
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp "$hosts" "$scratch/hosts.before"
if awk '{sub(/#.*/, ""); for (i = 2; i <= NF; i++) if ($i == "github.com" || $i == "api.github.com") found = 1} END {exit !found}' "$hosts"; then
  echo 'Unexpected pre-existing GitHub loopback fixture routing' >&2
  exit 1
fi
cat >"$scratch/root.cnf" <<'EOF'
[req]
distinguished_name = root_dn
x509_extensions = root_extensions
prompt = no
[root_dn]
CN = Agentrans disposable macOS update test CA
[root_extensions]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
cat >"$scratch/leaf.ext" <<'EOF'
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:github.com,DNS:api.github.com
EOF
openssl req -new -x509 -newkey rsa:2048 -nodes -days 1 -sha256 -config "$scratch/root.cnf" \
  -keyout "$scratch/root.key" -out "$root_ca" 2>"$scratch/keygen.log"
openssl req -new -newkey rsa:2048 -nodes -sha256 -subj '/CN=github.com' \
  -keyout "$scratch/leaf.key" -out "$scratch/leaf.csr" 2>>"$scratch/keygen.log"
openssl x509 -req -in "$scratch/leaf.csr" -CA "$root_ca" -CAkey "$scratch/root.key" -CAcreateserial \
  -days 1 -sha256 -extfile "$scratch/leaf.ext" -out "$scratch/leaf.pem"
fingerprint=$(openssl x509 -in "$root_ca" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d ':')
[[ $fingerprint =~ ^[A-Fa-f0-9]{40}$ ]]
sudo -n /usr/bin/security add-trusted-cert -d -r trustRoot -p ssl -k "$keychain" "$root_ca"
trusted=1
hosts_changed=1
printf '\n127.0.0.1 github.com api.github.com # disposable Agentrans update fixture\n' | sudo -n /usr/bin/tee -a "$hosts" >/dev/null
flush_hosts
node --input-type=module -e '
  import { lookup } from "node:dns/promises";
  for (const host of ["github.com", "api.github.com"]) {
    const { address } = await lookup(host, { family: 4 });
    if (address !== "127.0.0.1") throw Error("Expected local update fixture routing");
  }
'

# Only socket binding needs elevated privileges. The test and Electron run as the normal runner account.
sudo -n /usr/bin/env -i HOME="$HOME" USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  GITHUB_ACTIONS="$GITHUB_ACTIONS" GITHUB_REF="$GITHUB_REF" GITHUB_REPOSITORY="$GITHUB_REPOSITORY" GITHUB_WORKSPACE="$GITHUB_WORKSPACE" \
  RUNNER_ENVIRONMENT="$RUNNER_ENVIRONMENT" RUNNER_OS="$RUNNER_OS" RUNNER_ARCH="$RUNNER_ARCH" RUNNER_TEMP="$RUNNER_TEMP" \
  QA_ARCH="$QA_ARCH" QA_OLD_ZIP="$QA_OLD_ZIP" QA_NEW_ZIP="$QA_NEW_ZIP" QA_REPORT_DIR="$QA_REPORT_DIR" \
  QA_TLS_KEY="$scratch/leaf.key" QA_TLS_CERT="$scratch/leaf.pem" QA_TLS_ROOT_CA="$root_ca" NODE_EXTRA_CA_CERTS="$root_ca" \
  /usr/bin/python3 - "$(id -u)" "$(id -g)" "$(command -v node)" "$GITHUB_WORKSPACE/scripts/verify-macos-ed25519-update.mjs" <<'PY'
import os
import socket
import sys

uid, gid = map(int, sys.argv[1:3])
node, script = sys.argv[3:5]
if uid == 0 or gid == 0:
    raise RuntimeError('A non-root runner account is required')
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(('127.0.0.1', 443))
listener.listen(128)
for key in ('QA_FIRST_LISTENER_FD', 'QA_SECOND_LISTENER_FD'):
    descriptor = os.dup(listener.fileno())
    os.set_inheritable(descriptor, True)
    os.environ[key] = str(descriptor)
listener.close()
os.setgroups([])
os.setgid(gid)
os.setuid(uid)
if os.getuid() != uid or os.geteuid() != uid:
    raise RuntimeError('Could not drop socket setup privileges')
os.execve(node, [node, script], os.environ)
PY
