#!/bin/sh

set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_dir"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Quizzer requires Node.js 20 or newer and npm."
  exit 1
fi

tailscale_ip=""
if command -v tailscale >/dev/null 2>&1; then
  tailscale_ip=$(tailscale ip -4 2>/dev/null | head -n 1 || true)
fi

if [ -z "$tailscale_ip" ] && command -v ifconfig >/dev/null 2>&1; then
  tailscale_ip=$(ifconfig | awk '$1 == "inet" && $2 ~ /^100\./ { print $2; exit }')
fi

if [ -z "$tailscale_ip" ]; then
  echo "No Tailscale IPv4 address was found. Connect Tailscale, then run this file again."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing Quizzer dependencies…"
  npm ci --legacy-peer-deps
fi

quizzer_service_pid=""
cleanup() {
  if [ -n "$quizzer_service_pid" ]; then
    kill "$quizzer_service_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

node server.mjs &
quizzer_service_pid=$!

echo ""
echo "Quizzer will be available on your Tailscale network at:"
echo "http://$tailscale_ip:5173/"
echo ""
echo "Press Control-C to stop Quizzer."
echo ""

npm exec -- vite --host "$tailscale_ip"
