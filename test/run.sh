#!/bin/bash
# Runs every tool against a pretend Switch (see README.md in this folder).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
SD="$T/sd"
WORK="$T/work"
mkdir -p "$SD/switch/my-game/test-results/r1" "$SD/emummc" "$SD/atmosphere/crash_reports" "$WORK/my-game"
printf 'run r1\n' > "$SD/switch/my-game/test-done.txt"
for i in $(seq 1 30); do echo "[perf] frame $i 16.2ms"; done > "$SD/switch/my-game/game.log"
printf 'started r1\nended r1\n' > "$SD/switch/my-game/test-results/progress.txt"
echo "r1 log" > "$SD/switch/my-game/test-results/r1/game.log"
printf '[emummc]\nenabled=1\nnintendo_path=emuMMC/RAW1/Nintendo\n' > "$SD/emummc/emummc.ini"
echo crash > "$SD/atmosphere/crash_reports/example.log"
head -c 200000 /dev/urandom > "$WORK/my-game/my-game.nro"
printf 'run r2\n' > "$WORK/my-game/test.txt"

python3 "$HERE/ftpserver.py" "$SD" > "$T/ftp.log" 2>&1 &
FTP_PID=$!
node "$HERE/mocks.js" "$SD" ok > "$T/mocks.log" 2>&1 &
MOCK_PID=$!
trap 'kill $FTP_PID $MOCK_PID 2>/dev/null' EXIT
sleep 1.5

cat > "$T/calls.json" <<'EOF'
[
  ["switch_status", {}],
  ["switch_press", {"sequence": "HOME, W200, +R, A, W100, -R, stick L up, W50, stick L center, touch 640 360, A x2, DOWN"}],
  ["switch_screenshot", {"save_as": "shot.jpg"}],
  ["switch_screenshot", {"method": "capture"}],
  ["switch_list_files", {"path": "/switch/my-game"}],
  ["switch_read_file", {"path": "/switch/my-game/game.log", "tail_lines": 3}],
  ["switch_move", {"from": "/switch/my-game/test-results", "to": "/switch/my-game/old-results/round1"}],
  ["switch_move", {"from": "/atmosphere/contents", "to": "/switch/x"}],
  ["switch_write_file", {"path": "/switch/my-game/test.txt", "local_path": "my-game/test.txt"}],
  ["switch_write_file", {"path": "/switch/my-game/my-game.nro", "local_path": "my-game/my-game.nro"}],
  ["switch_write_file", {"path": "/atmosphere/hosts/default.txt", "content": "x"}],
  ["switch_download_folder", {"sd_path": "/switch/my-game/old-results/round1", "local_path": "my-game/test-results"}],
  ["switch_download_folder", {"sd_path": "/atmosphere/crash_reports", "local_path": "crash_reports"}],
  ["switch_wait_for_file", {"path": "/switch/my-game/old-results/round1/progress.txt", "contains": "ended r1", "timeout_seconds": 10}],
  ["switch_launch_nro", {"local_path": "my-game/my-game.nro", "sd_path": "/switch/my-game/test.nro", "args": ["--fast"], "wait_seconds": 2}],
  ["switch_read_output", {}],
  ["switch_run_build", {"script": "my-game/build.sh"}],
  ["switch_botbase_command", {"command": "isProgramRunning 0x0100000000001000"}]
]
EOF
node "$HERE/client.js" "$HERE/../extension/server/index.js" "$T/calls.json" \
  "{\"SWITCH_IP\":\"127.0.0.1\",\"FTP_PORT\":\"2121\",\"FTP_USER\":\"claude\",\"FTP_PASS\":\"s3cret\",\"WORK_DIR\":\"$WORK\"}"
echo
echo "Expected errors: the move and write outside /switch, and run_build (off)."
