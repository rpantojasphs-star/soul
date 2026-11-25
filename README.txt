SOUL  -  a fast, themeable VRChat companion
===========================================

HOW TO INSTALL
1. Run Soul-Setup-3.2.0.exe. It installs Soul for just you (no admin needed),
   adds Start menu and desktop shortcuts, and an uninstaller in Windows'
   "Installed apps". Your history and settings are always kept.
   Windows may show "Windows protected your PC" because the app isn't signed:
   click "More info" -> "Run anyway".
   (Prefer no installer? Soul.exe also runs on its own from anywhere.)
2. Click "Sign in to VRChat" at the bottom of the sidebar.

YOU DON'T NEED VRCX ANYMORE
- Soul records its own history in %APPDATA%\Soul\soul.sqlite3:
  * Live from VRChat (while signed in): friends coming online/offline, moving
    worlds, status / bio / avatar changes, adds, unfriends, name changes,
    invites, pokes and other notifications - instantly.
  * From VRChat's own log files on this PC: the worlds you visit, how long you
    stay, who you meet and for how long, and videos played.
- If VRCX is installed, Soul also reads VRCX's old history (read-only, it never
  changes it) and merges it in, skipping anything both apps recorded.
- History only records while Soul is running. Turn on Settings -> "Start Soul
  when Windows starts" to keep it recording in the background.

WINDOW
- Closing the Soul window quits Soul completely (after a few seconds).
  Minimizing it keeps Soul running in the background.

ALERTS (Settings)
- Friend comes online (favorites only / everyone / off), pokes, invites, invite
  requests, friend requests, accepted requests, group announcements.
- Shown inside Soul and as Windows notifications, with an optional sound.

FAVORITES
- Hover a friend and click the star, or use the button in their profile.
- "Favorites" filter on the Friends page; favorites are pinned to the top.
- Settings -> "Import my VRChat favorites" copies the ones you starred in VRChat.

FRIEND REQUESTS
- Notifications -> Friend requests: Accept or Decline right in Soul.

PEOPLE
- The People page: type any name to search everyone on VRChat. Each result
  shows "Friend" if they're already your friend, or an "Add friend" button.
- Open anyone's profile to Add friend, Cancel a request you sent, Accept a
  request they sent you, or Unfriend.

MY PROFILE
- The My Profile page: change your status, status message, pronouns, bio
  and links, with a preview of how people see you. Saved straight to VRChat.
- With VRC+ you can also pick or upload your profile picture there.

AVATARS
- The Avatars page: your VRChat favorite avatars, your own uploads and the
  ones you've worn recently. Search, star/unstar favorites and "Wear this".

PHONE
- Settings -> Phone: turn on "Use Soul on my phone", then scan the QR code
  with your phone (same Wi-Fi). Use "Add to Home Screen" to open it like an
  app. Keep the link private. Windows may ask to allow Soul on your network
  the first time - click Allow.

UPDATES
- Soul checks github.com/rpantojasphs-star/soul for new versions every few
  hours. When one is out, you'll see "Update to Soul x.y" in the sidebar;
  click it, then "Update now". Soul downloads it and restarts by itself.

INVITES, STATUS, NOTES, AVATARS
- In someone's profile: Invite to my world, Ask to join, Poke, a note box
  (saved in Soul and synced to VRChat's notes) and your mutual friends.
- Notifications -> Invites: "launch" opens the world, "invite me in-game" sends
  you an invite inside VRChat. Invite requests have "invite them".
- Click your name in the sidebar to change your status (Join Me / Online /
  Ask Me / Do Not Disturb) and status text.
- My Worlds -> My uploads: your own avatars, with "Wear this" to switch.

WHERE YOU ARE
- While you're in VRChat, the top of the Friends page shows your world, how
  long you've been there, everyone in your instance, and friends in other
  instances of the same world.

INVITE MESSAGES
- Inviting someone or asking to join lets you pick one of your saved VRChat
  messages (or none). Soul remembers your last pick.

EXPLORE WORLDS
- Search VRChat's worlds, keep favorite worlds, see your recently visited ones.
- Open any world to see its details, friends there now, your own visit stats,
  public instances (Launch / Invite me), or start your own instance
  (Friends+, Friends, Invite+, Invite, Public; pick a region) and get invited.

GROUPS
- Your groups with member counts, their latest announcement, and group
  instances that are open right now.

PHOTOS
- Your VRChat screenshots (from Pictures\VRChat), newest first. Click one to
  see which world it was taken in and who was there.

VR (SteamVR)
- When SteamVR is running, Soul adds a small panel on your wrist (who's online,
  where you are) and pops alerts up in front of you for a few seconds.
- Settings -> VR: turn it on/off, pick the hand, and optionally send alerts to
  XSOverlay or OVR Toolkit instead/as well.

BACKUP & EXPORT (Settings)
- "Download backup" saves a full copy of Soul's history.
- Export the feed, friend log, world visits, people met or notifications as CSV
  files you can open in Excel or Google Sheets.

POKES & CUSTOM EMOJIS
- Hover a friend and click the hand, or hit Poke in their profile.
- Shift+click the hand to instantly re-send your last poke.
- Custom emojis (VRChat Plus): in a poke, "My custom emojis" -> "+ Add emoji".
  PNG, JPG, GIF, WebP or short MP4; GIFs and videos become animated emojis.

PROFILES
- Click anyone to see their current avatar (who made it, content warnings),
  avatars they've worn, pronouns, platform, languages, join date and more.

PRIVACY
- Your password goes straight to VRChat and is never saved. Soul keeps only
  the login session in %APPDATA%\Soul\session.json, like VRCX does.

SHORTCUTS
Ctrl+K search  -  Alt+1..9 switch pages  -  Esc close a panel

IF SOMETHING BREAKS
Check %APPDATA%\Soul\soul-error.log (and soul-overlay.log for VR)

SOURCE
server.ts (backend), overlay.ts (SteamVR helper) and index.html (the whole UI).
Run from source with Bun:
  bun server.ts

CREDITS
The VR overlay uses Valve's OpenVR (openvr_api.dll), Copyright (c) 2015,
Valve Corporation, BSD 3-Clause license.
