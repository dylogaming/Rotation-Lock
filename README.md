# Rotation Lock

<p align="center">
  <img src="images/unlocked.png" width="320" alt="Unlocked state" />
  <img src="images/locked.png" width="320" alt="Locked state" />
</p>

A simple Windows desktop & tray application designed for laptops that can turn into tablets upon rotation. Sometimes, when I work on my laptop in bed, I'll lie down sideways, or it falls to the side. Either situation causes the device to do a full rotation and go into tablet mode. This is annoying and has no way to prevent aside from disabling the sensor in Device Manager. This program resolves that issue.

## Taskbar & Tray icon

<table>
<tr>
<td align="center"><img src="images/tray-unlocked.png" width="48" /></td>
<td align="center"><img src="images/tray-locked.png" width="48" /></td>
</tr>
<tr>
<td align="center"><b>Unlocked</b></td>
<td align="center"><b>Locked</b></td>
</tr>
</table>

The same icon shows in the system tray and on the taskbar. Left-click to toggle, right-click for menu.

## Install

Download `Rotation Lock.exe` from [Releases](https://github.com/dylogaming/Rotation-Lock/releases). 

Run it. UAC prompts for elevation (needed to access the sensor driver). 

Single self-contained `.exe`, no installer.

## Build from source

```sh
git clone https://github.com/dylogaming/Rotation-Lock.git
cd Rotation-Lock
cargo build --release --manifest-path src-tauri/Cargo.toml
```

## License

Proprietary: see [LICENSE](LICENSE). Free for personal use.

## Contact

dylogamingofficial@gmail.com :: [Ko-fi](https://ko-fi.com/dylogaming) ☕
