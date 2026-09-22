#!/bin/sh
set -eu
root_dir=$(pwd)
node_bin=$(command -v node)
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/garnet-runner.service" <<EOF
[Unit]
Description=Garnet host agent runner
After=network.target

[Service]
Type=simple
WorkingDirectory=$root_dir
ExecStart=$node_bin $root_dir/build/runner.mjs --runtime $root_dir/data/runtime
Environment=PATH=$PATH
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
# Retire the previous name before starting a runner on the same private socket.
if systemctl --user is-enabled ed-runner.service >/dev/null 2>&1; then
  systemctl --user disable --now ed-runner.service
fi
systemctl --user enable --now garnet-runner.service
echo 'Host runner installed. Check: systemctl --user status garnet-runner'
