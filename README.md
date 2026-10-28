# Switch Remote

A Claude desktop extension that lets Claude control your modded Nintendo Switch over your home network. Claude can press buttons, look at the screen, move files on the SD card, and send and launch homebrew builds.

I made it for testing homebrew games on a real console. Claude starts the game, plays through a test, watches the screen, swaps test files and pulls the logs back to the PC. I don't have to copy files over by hand any more.

**Enjoying it?** Tips are welcome but never expected: [buy me a coffee](https://buymeacoffee.com/mamesj) or [PayPal](https://paypal.me/mamesj).

## What Claude can do

| Tool | What it does |
| --- | --- |
| `switch_status` | Checks the connection: sys-botbase, the FTP server, the running game, battery |
| `switch_press` | Buttons, sticks and touch as a sequence, e.g. `HOME, W1500, A, A x3, stick L up, W500, stick L center` |
| `switch_screenshot` | A screenshot of whatever is on screen |
| `switch_list_files` / `switch_read_file` | Browse and read the SD card, e.g. a game's log |
| `switch_write_file` | Put a file inside `/switch` on the SD card, e.g. a new `.nro` or a test script |
| `switch_move` | Rename or move inside `/switch`, e.g. put last round's results aside |
| `switch_download_folder` | Copy a whole folder from the SD card to the PC |
| `switch_wait_for_file` | Wait until the game writes a file, or a line in one |
| `switch_launch_nro` | Send a `.nro` to the homebrew menu's netloader, launch it, and collect what it prints |
| `switch_run_build` | Run your own `.sh` build script through WSL (Windows, off unless you turn it on) |
| `switch_botbase_command` | Any other sys-botbase command |

## What you need

- A Switch running Atmosphère. Tested on firmware 22.5.0 with Atmosphère 1.12.0 and emuMMC.
- The Claude desktop app, on the same network as the Switch.
- Docker and git, to build the FTP sysmodule: on Windows inside WSL, or on Linux or macOS.

## Setup

1. **Build the sysmodules.** In WSL, Linux or macOS, from this repository:
   ```
   bash sysmodules/build-sysmodules.sh
   ```
   It builds sys-botbase and ftpsrv into `sysmodules/SD`, makes an FTP login, and prints it at the end.
2. **Copy everything inside `sysmodules/SD` to the root of your SD card** (with DBI's MTP, a card reader or hekate's USB tools), then reboot.
3. **Install the extension.** Download `switch-remote-<version>.mcpb` from Releases and open it with the Claude desktop app. Enter your Switch's IP address (System Settings > Internet > Connection Status) and the FTP user and password the build printed.
4. **Ask Claude to check your Switch.** It should report sys-botbase and FTP as OK.

While testing, set **System Settings > Sleep Mode > Auto-Sleep** to Never. Nothing can wake a sleeping Switch remotely.

## A test round

Ask Claude something like *"Run test round 3 of my game on the Switch"*, and it can:

1. Run your build script (if you've allowed build scripts).
2. Upload the new `.nro` and the test file into the game's folder under `/switch`.
3. Move the previous results aside.
4. Start the game with button presses and take screenshots to check where it is.
5. Wait for the game to write its results.
6. Copy the results folder to the PC and read the logs.

## Safety

- **sys-botbase has no password.** While it runs, anything on your network can send it button presses. Use it on a home network you trust. To turn it off, delete `atmosphere/contents/430000000000000B/flags`.
- The extension only changes files inside `/switch` on the SD card. It can read anywhere, so it can fetch crash reports from `/atmosphere`.
- On the PC it only reads and writes inside the work folder you choose in the extension settings.
- Build scripts are off by default.
- Use emuMMC and keep the console offline.

## Troubleshooting

- **The console crashes at boot with 2001-0132 in program 0100000000000013 (hid).** Too many sysmodules are using the controller service. The builds from `build-sysmodules.sh` don't connect to it at start-up, which fixed this on a console with several other sysmodules. If it still happens, take the SD card out, delete `atmosphere/contents/430000000000000B/flags`, and remove sysmodules you don't need.
- **Screenshots** come from sys-botbase. If the console refuses that, the extension presses CAPTURE and fetches the picture from the album instead, then deletes it.
- **Windows asks about network access** the first time you launch a `.nro` with `switch_launch_nro`. Allow it on private networks so the game's output can reach the PC.
- **Your Joy-Cons stop working in a game.** Button presses come from a virtual Pro Controller that connects as player 1. Ask Claude to send `detachController` to remove it.

## Credits and licences

- [sys-botbase](https://github.com/olliz0r/sys-botbase) by olliz0r, GPL-3.0. The release's `sys-botbase-quiet` zip is built from it with one small patch (`sysmodules/patches`).
- [ftpsrv](https://github.com/ITotalJustice/ftpsrv) by ITotalJustice. It doesn't publish a licence, so its builds aren't included here; `build-sysmodules.sh` builds it from its own source on your machine.
- [devkitPro](https://devkitpro.org) and libnx, and the homebrew menu's nxlink protocol.
- Everything else in this repository is MIT licensed (see `LICENSE`).

Built with Claude.
