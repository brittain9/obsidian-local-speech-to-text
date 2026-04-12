#!/bin/sh
# TODO: WE SHOULD FIND A BETTER WAY TO DO THIS, BUT THIS WORKS FOR NOW
# Wrapper that sets CUDA LD_LIBRARY_PATH only for the sidecar process.
#
# Inside a Flatpak sandbox, host /usr is mounted at /run/host/usr/ via
# --filesystem=host-os. Setting LD_LIBRARY_PATH globally on the Obsidian
# process contaminates Electron's audio library loading (PulseAudio, ALSA,
# PipeWire), breaking getUserMedia(). This wrapper scopes the library
# path to just the sidecar binary.
#
# Usage:
#   Set "Sidecar path override" in plugin settings to this script's
#   absolute path. The plugin passes sidecar args automatically.
#
# Configuration:
#   Edit SIDECAR_BINARY and CUDA_LD_PATH below to match your system.
#   Run `readlink -f /usr/local/cuda` on the host to find the real path.
#   Run `find /usr -name libcuda.so.1 2>/dev/null` for the driver lib.

SIDECAR_BINARY="/home/Alex/Projects/new/native/sidecar/target-cuda/debug/obsidian-local-stt-sidecar"

CUDA_LD_PATH="/run/host/usr/local/cuda-13.2/targets/x86_64-linux/lib:/run/host/usr/local/cuda-13.2/lib64:/run/host/usr/lib64"

export LD_LIBRARY_PATH="${CUDA_LD_PATH}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$SIDECAR_BINARY" "$@"
