# 👻 Soul

A fast, themeable VRChat companion for Windows — a friendlier take on VRCX.

## Download
Grab the latest **Soul-Setup** installer (or the portable `Soul.exe`) from the
[Releases page](https://github.com/rpantojasphs-star/soul/releases/latest).
Once installed, Soul updates itself from here.

## What it does
- **Friends** — who's online and where, grouped by world, with live updates from VRChat
- **Where you are** — your world, how long you've been there and who's with you
- **History** — feed, friend log, worlds you visit and people you meet (works with or without VRCX)
- **Alerts** — favorites coming online, pokes, invites, friend requests (in-app, Windows and VR)
- **Pokes** with any emoji, plus custom emoji uploads (VRC+)
- **Invites** with saved messages, **friend requests**, **status**, **notes**
- **Explore worlds**, start instances, **groups**, **photos**, **avatars** (favorites, uploads, wear)
- **VR overlay** for SteamVR (wrist panel + alerts), XSOverlay / OVR Toolkit alerts
- **Phone view** over your home Wi-Fi
- **Themes** — colors, backgrounds (image/GIF/video), see-through glass
- **Backup & CSV export**

Your VRChat password is sent straight to VRChat and never stored; Soul keeps only the
session on your PC. History lives in `%APPDATA%\Soul`.

## Building from source
Needs [Bun](https://bun.sh).
```
bun install
bun build server.ts --compile --minify --target=bun-windows-x64 --outfile dist/Soul.exe
```
Run locally with `bun server.ts`.

Soul is not affiliated with VRChat Inc.
