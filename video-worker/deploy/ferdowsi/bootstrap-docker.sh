#!/usr/bin/env bash
set -Eeuo pipefail

# Run as root on an Ubuntu GPU VM. This installs Docker and NVIDIA Container
# Toolkit only. The NVIDIA host driver must be supplied/installed by the VM
# image/provider and must already work with nvidia-smi.
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi
if [[ ! -r /etc/os-release ]]; then
  echo "Cannot identify operating system." >&2; exit 1
fi
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "Supported OS: Ubuntu. Detected: ${ID:-unknown}" >&2; exit 1
fi
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA driver is not installed/available. Stop here; install the provider-compatible host driver first, then rerun." >&2
  exit 2
fi
nvidia-smi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg

# Docker Engine from Docker's official Ubuntu repository.
install -m 0755 -d /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
ARCH="$(dpkg --print-architecture)"
CODENAME="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${CODENAME}
Components: stable
Architectures: ${ARCH}
Signed-By: /etc/apt/keyrings/docker.asc
EOF

# NVIDIA Container Toolkit official repository.
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  >/etc/apt/sources.list.d/nvidia-container-toolkit.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin nvidia-container-toolkit
systemctl enable --now docker
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker

echo "Docker/NVIDIA runtime installed. Verifying GPU passthrough..."
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
echo "Bootstrap complete. No VM, firewall, billing, or application settings were changed by this script."
