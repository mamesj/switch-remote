#!/bin/bash
# Builds the release files into ./dist (for the maintainer):
#   switch-remote-<version>.mcpb         the Claude desktop extension
#   sys-botbase-quiet-<version>.zip      sys-botbase built with the patch, ready for the SD card
# ftpsrv builds are not shared: ftpsrv has no published licence, so everyone builds it
# with sysmodules/build-sysmodules.sh.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$ROOT/extension/manifest.json")"
DIST="$ROOT/dist"
rm -rf "$DIST"
mkdir -p "$DIST"

echo "== Extension $VER"
python3 - "$ROOT/extension" "$DIST/switch-remote-$VER.mcpb" <<'PY'
import json, os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
json.load(open(os.path.join(src, 'manifest.json')))
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for rel in ('manifest.json', 'icon.png', 'server/index.js'):
        z.write(os.path.join(src, rel), rel)
print('   ' + out)
PY

echo "== Sysmodules"
bash "$ROOT/sysmodules/build-sysmodules.sh" "$DIST/SD"

echo "== sys-botbase release zip"
python3 - "$DIST" "$ROOT/sysmodules" "$VER" <<'PY'
import os, sys, zipfile
dist, mods, ver = sys.argv[1:4]
out = os.path.join(dist, f'sys-botbase-quiet-{ver}.zip')
base = 'atmosphere/contents/430000000000000B'
source = f'''sys-botbase, built for Switch Remote {ver}

This is sys-botbase by olliz0r, licensed under the GNU GPL v3 (LICENSE-sys-botbase.txt).
Source: https://github.com/olliz0r/sys-botbase at commit ae13548c587b75abf54f32032ad8d52f51eda05e
with one change, sys-botbase-no-led-at-start.patch (also in the Switch Remote repository,
sysmodules/patches): it does not flash the controller LED at start-up, so it does not
connect to the Switch's controller service (hid) until a command arrives.

Copy the atmosphere folder to the root of your SD card and reboot.
'''
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.write(os.path.join(dist, 'SD', base, 'exefs.nsp'), f'{base}/exefs.nsp')
    z.writestr(f'{base}/flags/boot2.flag', '')
    z.write(os.path.join(mods, 'LICENSE-sys-botbase.txt'), 'LICENSE-sys-botbase.txt')
    z.write(os.path.join(mods, 'patches', 'sys-botbase-no-led-at-start.patch'), 'sys-botbase-no-led-at-start.patch')
    z.writestr('SOURCE.txt', source)
print('   ' + out)
PY
rm -rf "$DIST/SD"
echo
ls -l "$DIST"
