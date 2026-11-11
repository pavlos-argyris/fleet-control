#!/usr/bin/env bash
set -euo pipefail
# CI runner only: avoid the observed Azure mirror DNS failure. APT signature verification stays enabled.
if [[ -f /etc/apt/apt-mirrors.txt ]]; then
  printf '%s\n' 'https://archive.ubuntu.com/ubuntu' 'https://security.ubuntu.com/ubuntu' | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
fi
sudo apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update
sudo apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y "$@"
