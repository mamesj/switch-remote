#!/bin/bash
# Builds the two Switch sysmodules that Switch Remote talks to, in devkitPro's Docker image:
#   sys-botbase  buttons, sticks, touch and screenshots   (port 6000)
#   ftpsrv       FTP access to the SD card                 (port 5000)
# Both get one small change (see patches/): neither connects to the Switch's controller
# service (hid) when it starts. They only did that to flash a controller LED, and with a few
# other sysmodules installed it crashed hid at boot (error 2001-0132).
#
# Needs Docker and git (Linux, macOS, or WSL on Windows). Run it again any time; it rebuilds.
#   bash build-sysmodules.sh            puts the files in ./SD next to this script
#   bash build-sysmodules.sh <folder>   puts them in <folder>
# Copy everything inside SD to the root of your SD card, then reboot the Switch.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/SD}"
WORK="${SWITCH_REMOTE_WORK:-$HOME/.cache/switch-remote}"
IMAGE=devkitpro/devkita64
BOTBASE_REPO=https://github.com/olliz0r/sys-botbase.git
BOTBASE_COMMIT=ae13548c587b75abf54f32032ad8d52f51eda05e   # sys-botbase 2.5 + metadata fix
FTPSRV_REPO=https://github.com/ITotalJustice/ftpsrv.git
FTPSRV_COMMIT=99253bdd62fac99f251f1bf25043afdf3f4b38e7    # ftpsrv 1.2.2 + fixes

for tool in git docker python3; do
  command -v "$tool" >/dev/null || { echo "$tool is needed. On Ubuntu/WSL: sudo apt install -y git docker.io python3"; exit 1; }
done
if docker info >/dev/null 2>&1; then
  DOCKER="docker"
else
  echo "Starting Docker (may ask for your password)..."
  if [ "$(ps -p 1 -o comm=)" = "systemd" ]; then sudo systemctl start docker; else sudo service docker start; fi
  for _ in $(seq 1 30); do sudo docker info >/dev/null 2>&1 && break; sleep 1; done
  DOCKER="sudo docker"
fi
run() { $DOCKER run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$1:$1" -w "$2" "$IMAGE" bash -c "$3"; }

# fetch <repo> <commit> <dir>: a clean checkout of exactly that commit
fetch() {
  [ -d "$3/.git" ] || git clone -q "$1" "$3"
  git -C "$3" fetch -q origin
  git -C "$3" checkout -q --force "$2"
  git -C "$3" clean -fdxq
}

mkdir -p "$WORK" "$OUT"

echo "== sys-botbase"
BB="$WORK/sys-botbase"
fetch "$BOTBASE_REPO" "$BOTBASE_COMMIT" "$BB"
git -C "$BB" apply "$HERE/patches/sys-botbase-no-led-at-start.patch"
run "$BB" "$BB/sys-botbase" "make -j8" > "$WORK/sys-botbase-build.log" 2>&1 \
  || { tail -30 "$WORK/sys-botbase-build.log"; echo "sys-botbase build failed (full log: $WORK/sys-botbase-build.log)"; exit 1; }
D="$OUT/atmosphere/contents/430000000000000B"
mkdir -p "$D/flags"
cp "$BB/sys-botbase/sys-botbase.nsp" "$D/exefs.nsp"
touch "$D/flags/boot2.flag"
echo "   built ($(stat -c %s "$D/exefs.nsp" 2>/dev/null || stat -f %z "$D/exefs.nsp") bytes)"

echo "== ftpsrv"
FS="$WORK/ftpsrv"
fetch "$FTPSRV_REPO" "$FTPSRV_COMMIT" "$FS"
git -C "$FS" apply "$HERE/patches/ftpsrv-no-hid-at-start.patch"
run "$FS" "$FS" "cmake --preset switch && cmake --build --preset switch" > "$WORK/ftpsrv-build.log" 2>&1 \
  || { tail -40 "$WORK/ftpsrv-build.log"; echo "ftpsrv build failed (full log: $WORK/ftpsrv-build.log)"; exit 1; }
D="$OUT/atmosphere/contents/420000000000011B"
mkdir -p "$D/flags"
cp "$FS/build/switch/420000000000011B/exefs.nsp" "$D/exefs.nsp"
[ -f "$FS/build/switch/420000000000011B/toolbox.json" ] && cp "$FS/build/switch/420000000000011B/toolbox.json" "$D/toolbox.json"
touch "$D/flags/boot2.flag"
echo "   built ($(stat -c %s "$D/exefs.nsp" 2>/dev/null || stat -f %z "$D/exefs.nsp") bytes)"

echo "== FTP login"
INI="$OUT/config/ftpsrv/config.ini"
if [ -f "$INI" ]; then
  echo "   keeping the existing $INI"
else
  mkdir -p "$(dirname "$INI")"
  PASS="$(python3 -c 'import secrets, string; a = string.ascii_letters + string.digits; print("".join(secrets.choice(a) for _ in range(16)))')"
  cat > "$INI" <<EOF
[Login]
anon = 0
user = "switch"
pass = "$PASS"

[Network]
port = 5000
timeout = 30

[Misc]
use_localtime = 1

[Log]
log = 0

[Nx]
mount_devices = 0
save_writable = 0
mount_bis = 0
led = 0
skip_ascii_convert = 0
EOF
fi
FTP_USER="$(sed -n 's/^user = "\(.*\)"/\1/p' "$INI" | head -1)"
FTP_PASS="$(sed -n 's/^pass = "\(.*\)"/\1/p' "$INI" | head -1)"

echo
echo "Done. Copy everything inside this folder to the root of your SD card, then reboot:"
echo "   $OUT"
(cd "$OUT" && find . -type f | sort | sed 's|^\./|     |')
echo
echo "Enter these in the Switch Remote extension settings:"
echo "   FTP user:     $FTP_USER"
echo "   FTP password: $FTP_PASS"
echo "   FTP port:     5000"
