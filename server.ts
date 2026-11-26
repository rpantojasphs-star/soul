// Soul — a fast, themeable VRChat companion.
// Keeps its own history in %APPDATA%\\Soul\\soul.sqlite3 and reads VRCX's database READ-ONLY if it exists.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import html from "./index.html" with { type: "text" };
import { runOverlayChild } from "./overlay.ts";
import dgram from "node:dgram";
import QRCode from "qrcode";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import icon256 from "./icon-256.png" with { type: "file" };

const VERSION = "3.3.0";
const APPDATA = process.env.APPDATA || join(process.env.HOME || ".", ".config");
const args = process.argv.slice(2);
const BACKGROUND = args.includes("--background");
const NO_OPEN = args.includes("--no-open") || BACKGROUND || process.env.SOUL_NO_OPEN === "1";

// ---------- locate VRCX database ----------
function findDb(): string {
  if (process.env.VRCX_DB) return process.env.VRCX_DB;
  const vrcxDir = join(APPDATA, "VRCX");
  try {
    const cfg = JSON.parse(readFileSync(join(vrcxDir, "VRCX.json"), "utf8").replace(/^﻿/, ""));
    const loc = cfg.VRCX_DatabaseLocation;
    if (loc && existsSync(loc)) return loc;
  } catch {}
  return join(vrcxDir, "VRCX.sqlite3");
}
const DB_PATH = findDb();
const DATA_DIR = process.env.SOUL_DATA || join(APPDATA, "Soul");
const BG_DIR = join(DATA_DIR, "backgrounds");
mkdirSync(BG_DIR, { recursive: true });
const THEME_FILE = join(DATA_DIR, "theme.json");
// carry over the theme and backgrounds from when the app was called Lumen
try {
  const OLD = join(APPDATA, "Lumen");
  if (!existsSync(THEME_FILE) && existsSync(join(OLD, "theme.json"))) {
    writeFileSync(THEME_FILE, readFileSync(join(OLD, "theme.json")));
    const oldBg = join(OLD, "backgrounds");
    if (existsSync(oldBg)) for (const f of readdirSync(oldBg)) writeFileSync(join(BG_DIR, f), readFileSync(join(oldBg, f)));
  }
} catch {}

// Soul runs without a console window, so write crashes to a log file you can find.
const LOG_FILE = join(DATA_DIR, "soul-error.log");
const logErr = (e: any) => { try { writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${e?.stack || e}\n`, { flag: "a" }); } catch {} };
process.on("uncaughtException", logErr);
process.on("unhandledRejection", logErr);

// "Soul.exe --overlay" is the small helper process that draws Soul inside SteamVR
if (args.includes("--overlay")) { await runOverlayChild(+(args.find((a) => a.startsWith("--port="))?.slice(7) || 7317), DATA_DIR); await new Promise(() => {}); }

// ===================================================================================
// DATA LAYER
// Soul keeps its own database (soul.sqlite3) and, if VRCX is installed, also reads
// VRCX's database read-only. Every query runs on both and the results are merged,
// with duplicates removed (both apps record the same events when both are running).
// ===================================================================================
type Src = { name: "soul" | "vrcx"; db: Database; P: string; tables: Set<string> };
const sources: Src[] = [];

const SOUL_DB_PATH = join(DATA_DIR, "soul.sqlite3");
const sdb = new Database(SOUL_DB_PATH, { create: true });
sdb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000; PRAGMA synchronous = NORMAL;");
sdb.exec(`
CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS gamelog_location (id INTEGER PRIMARY KEY, created_at TEXT, location TEXT, world_id TEXT, world_name TEXT, time INTEGER, group_name TEXT, UNIQUE(created_at, location));
CREATE TABLE IF NOT EXISTS gamelog_join_leave (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, display_name TEXT, location TEXT, user_id TEXT, time INTEGER, UNIQUE(created_at, type, display_name));
CREATE TABLE IF NOT EXISTS gamelog_video_play (id INTEGER PRIMARY KEY, created_at TEXT, video_url TEXT, video_name TEXT, video_id TEXT, location TEXT, display_name TEXT, user_id TEXT, UNIQUE(created_at, video_url));
CREATE TABLE IF NOT EXISTS gamelog_event (id INTEGER PRIMARY KEY, created_at TEXT, data TEXT, UNIQUE(created_at, data));
CREATE TABLE IF NOT EXISTS cache_avatar (id TEXT PRIMARY KEY, added_at TEXT, author_id TEXT, author_name TEXT, created_at TEXT, description TEXT, image_url TEXT, name TEXT, release_status TEXT, thumbnail_image_url TEXT, updated_at TEXT, version INTEGER);
CREATE TABLE IF NOT EXISTS feed_gps (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, location TEXT, world_name TEXT, previous_location TEXT, time INTEGER, group_name TEXT);
CREATE TABLE IF NOT EXISTS feed_status (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, status TEXT, status_description TEXT, previous_status TEXT, previous_status_description TEXT);
CREATE TABLE IF NOT EXISTS feed_bio (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, bio TEXT, previous_bio TEXT, bio_links TEXT DEFAULT '[]', previous_bio_links TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS feed_avatar (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, owner_id TEXT, avatar_name TEXT, current_avatar_image_url TEXT, current_avatar_thumbnail_image_url TEXT, previous_current_avatar_image_url TEXT, previous_current_avatar_thumbnail_image_url TEXT);
CREATE TABLE IF NOT EXISTS feed_online_offline (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, type TEXT, location TEXT, world_name TEXT, time INTEGER, group_name TEXT);
CREATE TABLE IF NOT EXISTS friend_log_current (user_id TEXT PRIMARY KEY, display_name TEXT, trust_level TEXT, friend_number INTEGER);
CREATE TABLE IF NOT EXISTS friend_log_history (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, user_id TEXT, display_name TEXT, previous_display_name TEXT, trust_level TEXT, previous_trust_level TEXT, friend_number INTEGER);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, created_at TEXT, type TEXT, sender_user_id TEXT, sender_username TEXT, receiver_user_id TEXT, message TEXT, world_id TEXT, world_name TEXT, image_url TEXT, invite_message TEXT, request_message TEXT, response_message TEXT, expired INTEGER);
CREATE TABLE IF NOT EXISTS notifications_v2 (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, expires_at TEXT, type TEXT, link TEXT, link_text TEXT, message TEXT, title TEXT, image_url TEXT, seen INTEGER, sender_user_id TEXT, sender_username TEXT, data TEXT, responses TEXT, details TEXT);
CREATE TABLE IF NOT EXISTS notes (user_id TEXT PRIMARY KEY, display_name TEXT, note TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS user_profile (user_id TEXT PRIMARY KEY, bio TEXT, bio_links TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS avatar_history (avatar_id TEXT PRIMARY KEY, created_at TEXT, time INTEGER);
CREATE TABLE IF NOT EXISTS friend_state (user_id TEXT PRIMARY KEY, json TEXT);
CREATE TABLE IF NOT EXISTS favorites (user_id TEXT PRIMARY KEY, created_at TEXT);
CREATE TABLE IF NOT EXISTS fav_worlds (world_id TEXT PRIMARY KEY, name TEXT, thumb TEXT, author TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS photos (path TEXT PRIMARY KEY, created_at TEXT, location TEXT, world_name TEXT);
CREATE TABLE IF NOT EXISTS notif_state (id TEXT PRIMARY KEY, state TEXT, at TEXT);
CREATE INDEX IF NOT EXISTS i_fgps ON feed_gps(user_id); CREATE INDEX IF NOT EXISTS i_fst ON feed_status(user_id);
CREATE INDEX IF NOT EXISTS i_fbio ON feed_bio(user_id); CREATE INDEX IF NOT EXISTS i_fav ON feed_avatar(user_id);
CREATE INDEX IF NOT EXISTS i_foo ON feed_online_offline(user_id); CREATE INDEX IF NOT EXISTS i_jl ON gamelog_join_leave(user_id);
CREATE INDEX IF NOT EXISTS i_jlloc ON gamelog_join_leave(location);
`);
const tableSet = (d: Database) => new Set((d.query("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name));
sources.push({ name: "soul", db: sdb, P: "", tables: tableSet(sdb) });

let vdb: Database | null = null;
if (existsSync(DB_PATH)) {
  try {
    vdb = new Database(DB_PATH, { readonly: true });
    vdb.exec("PRAGMA busy_timeout = 4000");
    vdb.exec("PRAGMA query_only = 1");
    const tables = tableSet(vdb);
    const me = (vdb.query("SELECT value FROM configs WHERE key = 'config:lastuserloggedin'").get() as any)?.value || "";
    let P = me ? "usr" + me.slice(4).replace(/-/g, "") + "_" : "";
    if (!tables.has(P + "friend_log_current")) {
      const cand = [...tables].find((t) => /^usr[0-9a-f]{32}_friend_log_current$/.test(t));
      P = cand ? cand.replace("friend_log_current", "") : "";
    }
    sources.push({ name: "vrcx", db: vdb, P, tables });
  } catch (e) { logErr(e); vdb = null; }
}
const VSRC = sources.find((x) => x.name === "vrcx") || null;

const scfg = (key: string): string | null => (sdb.query("SELECT value FROM configs WHERE key = ?").get(key) as any)?.value ?? null;
const setScfg = (key: string, value: string) => sdb.query("INSERT INTO configs(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
let ME = scfg("me") || (VSRC ? ((VSRC.db.query("SELECT value FROM configs WHERE key = 'config:lastuserloggedin'").get() as any)?.value || "") : "");

// run a query template on every source that has the tables it names ({feed_gps} etc.)
const hasT = (src: Src, t: string) => src.tables.has(src.P + t);
function tmpl(src: Src, sql: string) { return sql.replace(/\{(\w+)\}/g, (_, n) => src.P + n); }
function each(sql: string, ...params: any[]): any[] {
  const need = [...sql.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const out: any[] = [];
  for (const src of sources) {
    if (!need.every((t) => hasT(src, t))) continue;
    try { for (const r of src.db.query(tmpl(src, sql)).all(...params) as any[]) { r._src = src.name; out.push(r); } } catch (e) { logErr(e); }
  }
  return out;
}
function dedupe<T>(rows: T[], key: (r: T) => string): T[] { const seen = new Set<string>(); return rows.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; }); }
const byAtDesc = (a: any, b: any) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

// change tracking: VRCX's data_version + Soul's own write counter + live updates
let soulVer = 0, liveVer = 0;
const bump = () => { soulVer++; };
const dataVersion = () => `${VSRC ? (VSRC.db.query("PRAGMA data_version").get() as any).data_version : 0}.${soulVer}.${liveVer}`;
let cacheVer = "";
const cache = new Map<string, any>();
function cached<T>(key: string, fn: () => T): T {
  const v = dataVersion();
  if (v !== cacheVer) { cache.clear(); cacheVer = v; }
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

function myName(): string {
  if (vrcUser?.displayName) return vrcUser.displayName;
  const r = each(`SELECT display_name FROM {notes} WHERE user_id = ?`, ME)[0] || each(`SELECT author_name AS display_name FROM cache_avatar WHERE author_id = ? LIMIT 1`, ME)[0];
  return r?.display_name || "You";
}

function latestActivity(): string | null {
  let m: string | null = null;
  for (const t of ["feed_online_offline", "feed_gps", "feed_status", "feed_avatar", "gamelog_location", "gamelog_join_leave"]) {
    const isLog = t.startsWith("gamelog");
    for (const r of each(`SELECT (SELECT created_at FROM ${isLog ? t : "{" + t + "}"} ORDER BY id DESC LIMIT 1) m`)) if (r.m && (!m || r.m > m)) m = r.m;
  }
  return m;
}
const lastVrcxActivity = () => {
  if (!VSRC) return null;
  let m: string | null = null;
  for (const t of ["feed_online_offline", "feed_gps", "gamelog_join_leave"]) {
    const name = t.startsWith("gamelog") ? t : VSRC.P + t;
    if (!VSRC.tables.has(name)) continue;
    const r = VSRC.db.query(`SELECT created_at m FROM ${name} ORDER BY id DESC LIMIT 1`).get() as any;
    if (r?.m && (!m || r.m > m)) m = r.m;
  }
  return m;
};

// ---------- people you've met (time together) ----------
// Raw "left" rows from both sources, de-duplicated, then added up per person.
const meetRows = new Map<string, { lastId: number; rows: Map<string, any> }>();
function meetAgg() {
  return cached("meetAgg", () => {
    const all = new Map<string, any>();
    for (const src of sources) {
      const st = meetRows.get(src.name) || { lastId: 0, rows: new Map() };
      meetRows.set(src.name, st);
      try {
        for (const r of src.db.query(`SELECT id, created_at, user_id, display_name, time FROM gamelog_join_leave WHERE id > ? AND type = 'OnPlayerLeft' ORDER BY id`).all(st.lastId) as any[]) {
          st.rows.set(r.created_at + "|" + (r.user_id || r.display_name), r); st.lastId = r.id;
        }
      } catch {}
      for (const [k, r] of st.rows) { const prev = all.get(k); if (!prev || (+r.time || 0) > (+prev.time || 0)) all.set(k, r); }
    }
    const per = new Map<string, any>();
    for (const r of all.values()) {
      if (!r.user_id || r.user_id === ME) continue;
      const p = per.get(r.user_id) || { id: r.user_id, name: r.display_name, time: 0, meets: 0, last: r.created_at, first: r.created_at };
      p.time += +r.time || 0; p.meets++;
      if (r.created_at > p.last) { p.last = r.created_at; p.name = r.display_name; }
      if (r.created_at < p.first) p.first = r.created_at;
      per.set(r.user_id, p);
    }
    return per;
  });
}

// ---------- friends ----------
type Latest = { lastId: number; map: Map<string, any> };
const latestState: Record<string, Latest> = {};
function latestPerUser(tbl: string, cols: string): Map<string, any> {
  const merged = new Map<string, any>();
  for (const src of sources) {
    const key = src.name + ":" + tbl;
    const st = (latestState[key] ||= { lastId: 0, map: new Map() });
    if (hasT(src, tbl)) {
      for (const r of src.db.query(`SELECT id, user_id, ${cols} FROM ${src.P}${tbl} WHERE id > ? ORDER BY id`).all(st.lastId) as any[]) { st.map.set(r.user_id, r); st.lastId = r.id; }
    }
    for (const [u, r] of st.map) { const p = merged.get(u); if (!p || r.created_at > p.created_at) merged.set(u, r); }
  }
  return merged;
}
function friendRoster(): any[] {
  const soulList = sdb.query(`SELECT user_id, display_name, trust_level, friend_number FROM friend_log_current`).all() as any[];
  if (soulList.length) return soulList;
  return VSRC && hasT(VSRC, "friend_log_current") ? (VSRC.db.query(`SELECT user_id, display_name, trust_level, friend_number FROM ${VSRC.P}friend_log_current`).all() as any[]) : [];
}
function favSet(): Set<string> { return new Set((sdb.query("SELECT user_id FROM favorites").all() as any[]).map((r) => r.user_id)); }
function friends() {
  if (session.auth && liveStale() && !pipe.connected) refreshLive();
  return cached("friends", () => {
    const oo = latestPerUser("feed_online_offline", "type, created_at, location, world_name, group_name");
    const gps = latestPerUser("feed_gps", "created_at, location, world_name, group_name");
    const st = latestPerUser("feed_status", "status, status_description, created_at");
    const av = latestPerUser("feed_avatar", "avatar_name, current_avatar_thumbnail_image_url AS thumb, created_at");
    const tg = meetAgg();
    const favs = favSet();
    const nowRef = Math.min(Date.now(), new Date(latestActivity() || Date.now()).getTime() + 3600_000) || Date.now();
    const notes = new Map<string, string>();
    for (const r of each(`SELECT user_id, note FROM {notes}`)) if (!notes.has(r.user_id) || r._src === "soul") notes.set(r.user_id, r.note);
    const list: any[] = friendRoster().map((r) => {
      const o = oo.get(r.user_id), g = gps.get(r.user_id), s = st.get(r.user_id), a = av.get(r.user_id);
      // a logged "Online" with nothing new for 18h counts as offline (an "Offline" was missed)
      const lastSeen = [o?.created_at, g?.created_at, s?.created_at, a?.created_at].filter(Boolean).sort().pop() || null;
      const fresh = lastSeen && nowRef - new Date(lastSeen).getTime() < 18 * 3600_000;
      const online = o?.type === "Online" && !!fresh;
      let location = "offline", world = "", group = "";
      if (online) {
        const useGps = g && g.created_at > o.created_at;
        location = (useGps ? g.location : o.location) || "private";
        world = (useGps ? g.world_name : o.world_name) || "";
        group = (useGps ? g.group_name : o.group_name) || "";
      }
      return {
        id: r.user_id, name: r.display_name, trust: r.trust_level, num: r.friend_number,
        online, since: online ? o?.created_at : lastSeen, location, world, group,
        status: s?.status || "", statusText: s?.status_description || "",
        avatar: a?.avatar_name || "", thumb: a?.thumb || "", note: notes.get(r.user_id) || "",
        together: tg.get(r.user_id)?.time || 0, fav: favs.has(r.user_id),
      };
    });
    if (!live) return list;
    // VRChat's own answer wins for who's online right now
    const byId = new Map(list.map((f) => [f.id, f]));
    for (const f of list) {
      const L = live.map.get(f.id);
      if (!L && f.online) { f.online = false; f.location = "offline"; f.world = ""; f.group = ""; }
    }
    for (const [id, L] of live.map) {
      let f = byId.get(id);
      if (!f) { f = { id, name: L.displayName, trust: trustOf(L.tags), num: 0, online: false, since: null, location: "offline", world: "", group: "", status: "", statusText: "", avatar: "", thumb: "", note: "", together: tg.get(id)?.time || 0, fav: favs.has(id) }; list.push(f); byId.set(id, f); }
      const loc = String(L.location || "offline");
      const inGame = loc.startsWith("wrld_") || loc === "private" || loc.startsWith("traveling");
      f.name = L.displayName || f.name;
      f.status = L.status || f.status; f.statusText = L.statusDescription ?? f.statusText;
      f.thumb = L.profilePicOverrideThumbnail || L.userIcon || L.iconUrl || L.currentAvatarThumbnailImageUrl || L.currentAvatarImageUrl || f.thumb;
      const fs = fstate.get(id);
      if (inGame) {
        if (!f.online || f.location !== loc) { f.world = loc.startsWith("wrld_") ? (loc === f.location && f.world) || worldName(loc.split(":")[0]) : ""; }
        f.since = fs?.onlineAt ? new Date(fs.onlineAt).toISOString() : f.online ? f.since : null;
        f.online = true; f.location = loc;
      } else {
        f.online = true; f.location = "web"; f.world = ""; f.group = "";
      }
    }
    return list;
  });
}

// ---------- live friend status straight from VRChat (when signed in) ----------
let live: { at: number; map: Map<string, any> } | null = null;
let liveBusy = false, liveErr = "";
const worldNames = new Map<string, string>();
const worldFetching = new Map<string, Promise<string>>();
function worldName(wid: string): string {
  if (!wid || !wid.startsWith("wrld_")) return "";
  if (worldNames.has(wid)) return worldNames.get(wid)!;
  const r = each(`SELECT world_name FROM gamelog_location WHERE world_id = ? AND world_name != '' ORDER BY id DESC LIMIT 1`, wid)[0]
    || each(`SELECT world_name FROM {feed_gps} WHERE location LIKE ? AND world_name != '' ORDER BY id DESC LIMIT 1`, wid + ":%")[0];
  if (r?.world_name) { worldNames.set(wid, r.world_name); return r.world_name; }
  fetchWorldName(wid);
  return "";
}
function fetchWorldName(wid: string): Promise<string> {
  if (worldNames.has(wid)) return Promise.resolve(worldNames.get(wid)!);
  if (!session.auth || !wid.startsWith("wrld_")) return Promise.resolve("");
  if (!worldFetching.has(wid)) {
    worldFetching.set(wid, vrc(`worlds/${wid}`).then((w) => { const n = w.status === 200 ? w.body?.name || "" : ""; if (n) { worldNames.set(wid, n); liveVer++; } return n; })
      .catch(() => "").finally(() => worldFetching.delete(wid)));
  }
  return worldFetching.get(wid)!;
}
async function worldNameAsync(wid: string) { return worldName(wid) || (await fetchWorldName(wid)); }
async function refreshLive() {
  if (liveBusy || !session.auth) return;
  liveBusy = true;
  try {
    const map = new Map<string, any>();
    for (let off = 0; off < 2000; off += 100) {
      const r = await vrc(`auth/user/friends?offline=false&n=100&offset=${off}`);
      if (r.status !== 200 || !Array.isArray(r.body)) { liveErr = r.status === 401 ? "signed out" : vrcError(r); if (r.status === 401) vrcUser = null; return; }
      for (const f of r.body) map.set(f.id, f);
      if (r.body.length < 100) break;
    }
    live = { at: Date.now(), map }; liveErr = ""; liveVer++;
  } catch (e: any) { liveErr = String(e?.message || e); }
  finally { liveBusy = false; }
}
function liveStale() { return !live || Date.now() - live.at > 60_000; }

// ---------- feed ----------
const FEEDS: Record<string, { tbl: string; sel: string; search: string }> = {
  online: { tbl: "feed_online_offline", sel: "type AS kind, location AS a, world_name AS b, NULL AS c, time AS d, NULL AS img", search: "display_name LIKE $q OR world_name LIKE $q" },
  gps: { tbl: "feed_gps", sel: "'GPS' AS kind, location AS a, world_name AS b, previous_location AS c, time AS d, NULL AS img", search: "display_name LIKE $q OR world_name LIKE $q" },
  status: { tbl: "feed_status", sel: "'Status' AS kind, status AS a, status_description AS b, previous_status AS c, previous_status_description AS d, NULL AS img", search: "display_name LIKE $q OR status_description LIKE $q" },
  avatar: { tbl: "feed_avatar", sel: "'Avatar' AS kind, avatar_name AS a, owner_id AS b, NULL AS c, NULL AS d, current_avatar_thumbnail_image_url AS img", search: "display_name LIKE $q OR avatar_name LIKE $q" },
  bio: { tbl: "feed_bio", sel: "'Bio' AS kind, bio AS a, previous_bio AS b, NULL AS c, NULL AS d, NULL AS img", search: "display_name LIKE $q OR bio LIKE $q" },
};
// The same event recorded by both Soul and VRCX lands a few milliseconds apart.
function dropNearDupes(rows: any[], windowMs: number, key: (r: any) => string) {
  rows.sort(byAtDesc);
  const lastAt = new Map<string, number>();
  return rows.filter((r) => {
    const k = key(r), t = new Date(r.at).getTime(), p = lastAt.get(k);
    if (p !== undefined && Math.abs(p - t) <= windowMs) return false;
    lastAt.set(k, t); return true;
  });
}
function feed(opts: { kinds: string[]; q?: string; before?: string; user?: string; limit: number }) {
  const out: any[] = [];
  for (const k of opts.kinds) {
    const f = FEEDS[k];
    if (!f) continue;
    const where: string[] = ["created_at < $before"];
    const params: any = { $before: opts.before || "9999", $limit: opts.limit };
    if (opts.q) { where.push(`(${f.search})`); params.$q = `%${opts.q}%`; }
    if (opts.user) { where.push("user_id = $user"); params.$user = opts.user; }
    for (const src of sources) {
      if (!hasT(src, f.tbl)) continue;
      out.push(...(src.db.query(`SELECT '${src.name}:${k}:' || id AS key, created_at AS at, user_id AS uid, display_name AS name, ${f.sel}
        FROM ${src.P}${f.tbl} WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $limit`).all(params) as any[]));
    }
  }
  return dropNearDupes(out, 15_000, (r) => `${r.kind}|${r.uid}|${r.a}|${r.b}`).slice(0, opts.limit);
}

// ---------- friend log ----------
function friendLog() {
  return cached("friendlog", () => dropNearDupes(
    each(`SELECT created_at AS at, type, user_id AS uid, display_name AS name, previous_display_name AS prevName,
        trust_level AS trust, previous_trust_level AS prevTrust, friend_number AS num FROM {friend_log_history}`),
    120_000, (r) => `${r.type}|${r.uid}|${r.name}|${r.trust}`));
}

// ---------- my worlds / stats ----------
function worlds() {
  return cached("worlds", () => {
    const visitsAll = each(`SELECT id, created_at AS at, location, world_id AS wid, world_name AS name, time, group_name AS grp FROM gamelog_location`);
    const vm = new Map<string, any>();
    for (const v of visitsAll) { const k = v.at + "|" + v.location; const p = vm.get(k); if (!p || (+v.time || 0) > (+p.time || 0)) vm.set(k, v); }
    const visits = [...vm.values()].sort(byAtDesc).map((v, i) => ({ ...v, id: i + 1 }));
    const per = meetAgg();
    const people = [...per.values()].sort((a, b) => b.time - a.time).slice(0, 100);
    const videos = dedupe(each(`SELECT created_at AS at, video_url AS url, video_name AS name, display_name AS by, location FROM gamelog_video_play ORDER BY id DESC LIMIT 300`), (r) => r.at + r.url).sort(byAtDesc).slice(0, 300);
    const events = dedupe(each(`SELECT created_at AS at, data FROM gamelog_event ORDER BY id DESC LIMIT 200`), (r) => r.at + r.data).sort(byAtDesc);
    const avatars = dedupe(each(`SELECT h.avatar_id AS id, h.created_at AS at, h.time, c.name, c.author_name AS author, c.thumbnail_image_url AS thumb
      FROM {avatar_history} h LEFT JOIN cache_avatar c ON c.id = h.avatar_id`), (r) => r.id).sort(byAtDesc);
    return { visits, people, uniquePeople: per.size, videos, events, avatars };
  });
}
function instancePeople(location: string, from: string, ms: number) {
  const end = new Date(new Date(from).getTime() + (ms || 0) + 60_000).toISOString();
  const rows = dedupe(each(`SELECT created_at, type, user_id, display_name, time FROM gamelog_join_leave WHERE location = ? AND created_at >= ? AND created_at <= ? AND user_id != ?`, location, from, end, ME),
    (r) => r.created_at + r.type + (r.user_id || r.display_name));
  const per = new Map<string, any>();
  for (const r of rows) {
    const p = per.get(r.user_id) || { id: r.user_id, name: r.display_name, time: 0 };
    if (r.type === "OnPlayerLeft") p.time += +r.time || 0;
    per.set(r.user_id, p);
  }
  return [...per.values()].sort((a, b) => b.time - a.time);
}

// ---------- notifications ----------
function notifications() {
  return cached("notifs", () => {
    const a = each(`SELECT id, created_at AS at, type, sender_user_id AS uid, sender_username AS name,
        message, world_name AS world, world_id AS location, invite_message AS inviteMsg, request_message AS requestMsg, response_message AS responseMsg,
        NULL AS title, image_url AS img, NULL AS link FROM {notifications} ORDER BY created_at DESC LIMIT 1500`);
    const b = each(`SELECT id, created_at AS at, type, sender_user_id AS uid, sender_username AS name,
        message, NULL AS world, NULL AS location, NULL AS inviteMsg, NULL AS requestMsg, NULL AS responseMsg,
        title, image_url AS img, link_text AS link FROM {notifications_v2} ORDER BY created_at DESC LIMIT 1500`);
    const states = new Map((sdb.query("SELECT id, state FROM notif_state").all() as any[]).map((r) => [r.id, r.state]));
    const friendIds = new Set(friendRoster().map((r) => r.user_id));
    return dedupe([...a, ...b], (r) => r.id).sort(byAtDesc).slice(0, 2000).map((r) => {
      if (r.type === "friendRequest") { r.state = states.get(r.id) || (friendIds.has(r.uid) ? "accepted" : pendingIds.has(r.id) || Date.now() - new Date(r.at).getTime() < 3 * 864e5 ? "pending" : "old"); }
      return r;
    });
  });
}

// ---------- one user ----------
function user(id: string) {
  const f = friends().find((x) => x.id === id) || null;
  const prof = each(`SELECT bio, bio_links, updated_at FROM {user_profile} WHERE user_id = ?`, id).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0] || null;
  const fl = friendLog().filter((r) => r.uid === id);
  const names = fl.filter((r) => r.type === "DisplayName").map((r) => ({ at: r.at, name: r.name, prev: r.prevName }));
  const log = fl.filter((r) => r.type !== "DisplayName").map((r) => ({ at: r.at, type: r.type }));
  const m = meetAgg().get(id);
  const met = m ? { time: m.time, meets: m.meets, last: m.last, first: m.first, name: m.name } : { time: 0, meets: 0 };
  const mutuals = each(`SELECT count(*) c FROM {mutual_graph_links} WHERE friend_id = ?`, id).reduce((s, r) => Math.max(s, r.c || 0), 0);
  const recent = feed({ kinds: Object.keys(FEEDS), user: id, limit: 60 });
  return { friend: f, avatars: avatarHistory(id), bio: prof?.bio || "", bioUpdated: prof?.updated_at || null, names, log, met, mutuals, recent };
}
function avatarHistory(id: string) {
  const rows = each(`SELECT avatar_name AS name, current_avatar_thumbnail_image_url AS thumb, owner_id AS ownerId, max(created_at) AS at, count(*) AS times
    FROM {feed_avatar} WHERE user_id = ? GROUP BY current_avatar_thumbnail_image_url`, id);
  const m = new Map<string, any>();
  for (const r of rows) { const p = m.get(r.thumb); if (!p) m.set(r.thumb, { ...r }); else { p.times += r.times; if (r.at > p.at) p.at = r.at; if (!p.name) p.name = r.name; } }
  return [...m.values()].sort(byAtDesc).slice(0, 24);
}
const trustOf = (tags: string[] = []) => tags.includes("system_trust_veteran") ? "Trusted User" : tags.includes("system_trust_trusted") ? "Known User" : tags.includes("system_trust_known") ? "User" : tags.includes("system_trust_basic") ? "New User" : "Visitor";

// ---------- a person's profile + current avatar (when signed in) ----------
const userCache = new Map<string, { at: number; v: any }>();
const fileCache = new Map<string, any>();
const nameCache = new Map<string, string>();
async function vrcUserInfo(id: string) {
  const c = userCache.get(id);
  if (c && Date.now() - c.at < 120_000) return c.v;
  const r = await vrc(`users/${id}`);
  if (r.status !== 200) return { error: vrcError(r), status: r.status };
  const u = r.body;
  let avatar: any = null;
  const img = u.currentAvatarImageUrl || "";
  const fid = (img.match(/file_[0-9a-f-]{36}/) || [])[0];
  if (fid) {
    if (!fileCache.has(fid)) {
      const f = await vrc(`file/${fid}`);
      fileCache.set(fid, f.status === 200 ? { name: (/Avatar - (.*) - Image -/i.exec(f.body?.name || "") || [])[1] || "", ownerId: f.body?.ownerId || "", created: f.body?.versions?.[0]?.created_at || "" } : null);
    }
    const fi = fileCache.get(fid);
    if (fi?.ownerId && !nameCache.has(fi.ownerId)) {
      const local = friends().find((x) => x.id === fi.ownerId)?.name;
      if (local) nameCache.set(fi.ownerId, local);
      else { const o = await vrc(`users/${fi.ownerId}`); if (o.status === 200) nameCache.set(fi.ownerId, o.body.displayName); }
    }
    avatar = { image: img, thumb: u.currentAvatarThumbnailImageUrl || img, name: fi?.name || "", authorId: fi?.ownerId || "", author: fi?.ownerId ? nameCache.get(fi.ownerId) || "" : "",
      own: fi?.ownerId === id, created: fi?.created || "", tags: u.currentAvatarTags || [] };
  }
  const tags: string[] = u.tags || [];
  const trust = tags.includes("system_trust_veteran") ? "Trusted User" : tags.includes("system_trust_trusted") ? "Known User" : tags.includes("system_trust_known") ? "User" : tags.includes("system_trust_basic") ? "New User" : "Visitor";
  const v = {
    id: u.id, name: u.displayName, pronouns: u.pronouns || "", bio: u.bio || "", links: u.bioLinks || [], status: u.status, statusText: u.statusDescription,
    pic: u.profilePicOverride || u.userIcon || u.currentAvatarImageUrl || "", banner: u.bannerUrl || "",
    platform: u.last_platform || u.platform || "", joined: u.date_joined || "", lastLogin: u.last_login || "", lastActivity: u.last_activity || "",
    ageVerified: !!u.ageVerified, vrcPlus: tags.includes("system_supporter"), trust,
    languages: tags.filter((t) => t.startsWith("language_")).map((t) => t.slice(9)), location: u.location || "", avatar,
  };
  userCache.set(id, { at: Date.now(), v });
  return v;
}
// a search result / any VRChat user, in the shape the People page shows
function personRow(u: any) {
  const friend = !!u.isFriend || fstate.has(u.id) || (vrcUser?.friends || []).includes(u.id);
  return { id: u.id, name: u.displayName, statusText: u.statusDescription || "", status: u.status || "", trust: trustOf(u.tags), pronouns: u.pronouns || "",
    thumb: u.profilePicOverrideThumbnail || u.profilePicOverride || u.userIcon || u.currentAvatarThumbnailImageUrl || "", platform: u.last_platform || "",
    friend, me: u.id === ME, vrcPlus: (u.tags || []).includes("system_supporter"), bio: (u.bio || "").slice(0, 140) };
}
// ---------- details about one avatar (from its picture) ----------
// VRChat only tells us which picture someone's avatar had. From the picture's file we get the
// avatar's name, who made it and when; if the avatar is public (or known from VRCX's cache)
// we can also find the avatar itself: platforms, performance, description, and let you wear it.
const avInfoCache = new Map<string, { at: number; v: any }>();
const PERF_ORDER = ["Excellent", "Good", "Medium", "Poor", "VeryPoor"];
async function avatarInfo(img: string, avatarId = "") {
  const fid = (img.match(/file_[0-9a-f-]{36}/) || [])[0] || "";
  const key = fid || avatarId;
  if (!key) return { error: "Unknown avatar." };
  const c = avInfoCache.get(key); if (c && Date.now() - c.at < 10 * 60_000) return c.v;
  const v: any = { fileId: fid, image: img };
  if (fid) {
    const f = await vrc(`file/${fid}`);
    if (f.status === 200) {
      const vers = (f.body.versions || []).filter((x: any) => x.version > 0);
      v.name = (/Avatar - (.*) - Image -/i.exec(f.body.name || "") || [])[1] || "";
      v.authorId = f.body.ownerId || "";
      v.created = vers[0]?.created_at || ""; v.imageUpdated = vers[vers.length - 1]?.created_at || ""; v.imageVersions = vers.length;
    }
    if (!avatarId) {
      const hit = each(`SELECT id FROM cache_avatar WHERE image_url LIKE ? OR thumbnail_image_url LIKE ? LIMIT 1`, `%${fid}%`, `%${fid}%`)[0];
      if (hit?.id) avatarId = hit.id;
    }
    if (!avatarId && v.authorId) {
      // public avatars by the same creator; match on the picture
      const r = await vrc(`avatars?userId=${v.authorId}&releaseStatus=public&n=100&sort=updated&order=descending`);
      const a = Array.isArray(r.body) ? r.body.find((x: any) => (x.imageUrl || "").includes(fid) || (x.thumbnailImageUrl || "").includes(fid)) : null;
      if (a) avatarId = a.id;
    }
  }
  if (avatarId && /^avtr_[0-9a-f-]{36}$/.test(avatarId)) {
    const r = await vrc(`avatars/${avatarId}`);
    if (r.status === 200) {
      const a = r.body, pk = a.unityPackages || [];
      const perf: Record<string, string> = {};
      for (const u of pk) if (u.performanceRating && u.performanceRating !== "None") { const k = u.platform; if (!perf[k] || PERF_ORDER.indexOf(u.performanceRating) > PERF_ORDER.indexOf(perf[k])) perf[k] = u.performanceRating; }
      Object.assign(v, { id: a.id, name: a.name || v.name, authorId: a.authorId || v.authorId, author: a.authorName || "", description: a.description || "", status: a.releaseStatus || "",
        created: a.created_at || v.created, updated: a.updated_at || "", version: a.version || 0, platforms: [...new Set(pk.map((u: any) => u.platform))], perf,
        tags: a.tags || [], image: a.imageUrl || img, thumb: a.thumbnailImageUrl || "", styles: [a.styles?.primary, a.styles?.secondary].filter(Boolean),
        impostor: pk.some((u: any) => u.variant === "impostor"), current: a.id === vrcUser?.currentAvatar });
    } else if (r.status === 404 || r.status === 403) v.privateNote = true;
  } else v.privateNote = true;
  if (v.authorId && !v.author) {
    if (!nameCache.has(v.authorId)) { const local = friends().find((x) => x.id === v.authorId)?.name; if (local) nameCache.set(v.authorId, local); else { const o = await vrc(`users/${v.authorId}`); if (o.status === 200) nameCache.set(v.authorId, o.body.displayName); } }
    v.author = nameCache.get(v.authorId) || "";
  }
  if (v.id) { const fav = await vrc("avatars/favorites?n=300"); v.fav = Array.isArray(fav.body) ? fav.body.find((x: any) => x.id === v.id)?.favoriteId || "" : ""; }
  avInfoCache.set(key, { at: Date.now(), v });
  return v;
}
// ---------- theme ----------
function readTheme() {
  try { return JSON.parse(readFileSync(THEME_FILE, "utf8")); } catch { return null; }
}
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".avif": "image/avif",
};

// ---------- VRChat account (for pokes) ----------
// Your password is sent straight to VRChat and never saved. Soul only keeps VRChat's session
// cookies in %APPDATA%\Soul\session.json so you stay signed in, like VRCX does.
const VRC = process.env.SOUL_VRC_API || "https://api.vrchat.cloud/api/1/";
const UA = `Soul/${VERSION} (personal VRCX companion)`;
const SESSION_FILE = join(DATA_DIR, "session.json");
let session: Record<string, string> = (() => { try { return JSON.parse(readFileSync(SESSION_FILE, "utf8")); } catch { return {}; } })();
const saveSession = () => { try { writeFileSync(SESSION_FILE, JSON.stringify(session)); } catch {} };
const cookieHeader = () => Object.entries(session).map(([k, v]) => `${k}=${v}`).join("; ");
let vrcUser: any = null, vrcUserAt = 0;

async function vrc(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json", ...(init.headers || {}) };
  const ck = cookieHeader(); if (ck) headers.Cookie = ck;
  if (init.body && typeof init.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(VRC + path, { ...init, headers, redirect: "follow" });
  for (const c of (res.headers as any).getSetCookie?.() || []) {
    const [kv] = c.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k === "auth" || k === "twoFactorAuth") { if (!v || /max-age=0|expires=thu, 01 jan 1970/i.test(c)) delete session[k]; else session[k] = v; saveSession(); }
  }
  let body: any = null; const text = await res.text();
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const vrcError = (r: { status: number; body: any }) => r.body?.error?.message?.replace(/^"|"$/g, "") || `VRChat said ${r.status}`;
const loginResult = (r: { status: number; body: any }) => {
  if (r.status !== 200) return { ok: false, error: vrcError(r) };
  if (r.body?.requiresTwoFactorAuth) return { ok: false, need2fa: r.body.requiresTwoFactorAuth.includes("emailOtp") ? "emailOtp" : "totp" };
  vrcUser = r.body; vrcUserAt = Date.now(); live = null; if (r.body.id) { ME = r.body.id; setScfg("me", ME); } setTimeout(startRecorder, 50);
  return { ok: true, user: { id: r.body.id, name: r.body.displayName, booping: r.body.isBoopingEnabled !== false } };
};
async function vrcStatus() {
  if (!session.auth) return { loggedIn: false };
  if (!vrcUser || Date.now() - vrcUserAt > 5 * 60_000) {
    const r = await vrc("auth/user");
    if (r.status !== 200 || r.body?.requiresTwoFactorAuth) { vrcUser = null; return { loggedIn: false, need2fa: r.body?.requiresTwoFactorAuth ? (r.body.requiresTwoFactorAuth.includes("emailOtp") ? "emailOtp" : "totp") : undefined }; }
    vrcUser = r.body; vrcUserAt = Date.now();
  }
  const u = vrcUser;
  const pic = u.profilePicOverrideThumbnail || u.userIcon || u.currentAvatarThumbnailImageUrl || "";
  return { loggedIn: true, id: u.id, name: u.displayName, vrcPlus: (u.tags || []).includes("system_supporter"), booping: u.isBoopingEnabled !== false,
    pic, status: u.status || "", statusText: u.statusDescription || "", state: u.state || "", onlineFriends: (u.onlineFriends || []).length,
    activeFriends: (u.activeFriends || []).length, friends: (u.friends || []).length, since: u.date_joined || "", twoFactor: !!u.twoFactorAuthEnabled, myLocation: myLocation(), currentAvatar: u.currentAvatar || "" };
}
const lastBoop = new Map<string, number>(); let lastAnyBoop = 0;
async function sendBoop(userId: string, emojiId?: string) {
  if (!/^usr_[0-9a-f-]{36}$/.test(userId)) return { ok: false, error: "That isn't a valid user." };
  const now = Date.now();
  if (now - (lastBoop.get(userId) || 0) < 5000) return { ok: false, error: "Slow down — wait a few seconds before poking them again." };
  if (now - lastAnyBoop < 1000) return { ok: false, error: "One poke per second, please." };
  lastBoop.set(userId, now); lastAnyBoop = now;
  const r = await vrc(`users/${userId}/boop`, { method: "POST", body: JSON.stringify(emojiId ? { emojiId } : {}) });
  if (r.status === 200) return { ok: true };
  if (r.status === 401) vrcUser = null;
  return { ok: false, status: r.status, error: vrcError(r) };
}

// ===================================================================================
// RECORDER — Soul's own history, so VRCX is optional.
//  1. VRChat's live connection ("pipeline"): friends going online/offline, moving worlds,
//     changing status/bio/avatar, friend adds/removes, notifications — instantly.
//  2. A full friend sync on sign-in and every 10 minutes to catch anything missed.
//  3. VRChat's own log files on this PC: worlds you visit, people you meet, videos.
// ===================================================================================
type FS = { name: string; trust: string; status: string; statusText: string; bio?: string; avatarImg: string; avatarThumb: string;
  location: string; online: boolean; onlineAt: number; locAt: number; worldName: string };
const fstate = new Map<string, FS>();
for (const r of sdb.query("SELECT user_id, json FROM friend_state").all() as any[]) { try { fstate.set(r.user_id, JSON.parse(r.json)); } catch {} }
const saveFs = sdb.query("INSERT INTO friend_state(user_id, json) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json");
const iso = (t = Date.now()) => new Date(t).toISOString();
const isGameLoc = (l: string) => !!l && (l.startsWith("wrld_") || l === "private" || l.startsWith("traveling"));
const groupOf = (loc: string) => "";

const ins = {
  oo: sdb.query("INSERT INTO feed_online_offline(created_at, user_id, display_name, type, location, world_name, time, group_name) VALUES(?,?,?,?,?,?,?,?)"),
  gps: sdb.query("INSERT INTO feed_gps(created_at, user_id, display_name, location, world_name, previous_location, time, group_name) VALUES(?,?,?,?,?,?,?,?)"),
  status: sdb.query("INSERT INTO feed_status(created_at, user_id, display_name, status, status_description, previous_status, previous_status_description) VALUES(?,?,?,?,?,?,?)"),
  bio: sdb.query("INSERT INTO feed_bio(created_at, user_id, display_name, bio, previous_bio) VALUES(?,?,?,?,?)"),
  avatar: sdb.query("INSERT INTO feed_avatar(created_at, user_id, display_name, owner_id, avatar_name, current_avatar_image_url, current_avatar_thumbnail_image_url, previous_current_avatar_image_url, previous_current_avatar_thumbnail_image_url) VALUES(?,?,?,?,?,?,?,?,?)"),
  flog: sdb.query("INSERT INTO friend_log_history(created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number) VALUES(?,?,?,?,?,?,?,?)"),
  fcur: sdb.query("INSERT INTO friend_log_current(user_id, display_name, trust_level, friend_number) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, trust_level = excluded.trust_level"),
  profile: sdb.query("INSERT INTO user_profile(user_id, bio, bio_links, updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET bio = excluded.bio, bio_links = excluded.bio_links, updated_at = excluded.updated_at"),
};
const avatarNames = new Map<string, Promise<{ name: string; owner: string }>>();
function avatarNameFor(imgUrl: string): Promise<{ name: string; owner: string }> {
  const fid = (imgUrl.match(/file_[0-9a-f-]{36}/) || [])[0];
  if (!fid || !session.auth) return Promise.resolve({ name: "", owner: "" });
  if (!avatarNames.has(fid)) avatarNames.set(fid, vrc(`file/${fid}`).then((f) => f.status === 200 ? { name: (/Avatar - (.*) - Image -/i.exec(f.body?.name || "") || [])[1] || "", owner: f.body?.ownerId || "" } : { name: "", owner: "" }).catch(() => ({ name: "", owner: "" })));
  return avatarNames.get(fid)!;
}

// Compare what VRChat says now with what Soul knew, and record whatever changed.
async function applyFriend(uid: string, u: any, opts: { online?: boolean; location?: string; silent?: boolean; at?: number } = {}) {
  const at = opts.at || Date.now(), when = iso(at);
  const prev = fstate.get(uid);
  const cur: FS = prev ? { ...prev } : { name: "", trust: "", status: "", statusText: "", bio: undefined, avatarImg: "", avatarThumb: "", location: "offline", online: false, onlineAt: 0, locAt: 0, worldName: "" };
  const silent = opts.silent || !prev;
  if (u) {
    if (u.displayName) cur.name = u.displayName;
    if (u.tags) cur.trust = trustOf(u.tags);
    if (u.status !== undefined) cur.status = u.status || "";
    if (u.statusDescription !== undefined) cur.statusText = u.statusDescription || "";
    if (u.bio !== undefined) cur.bio = u.bio || "";
    if (u.currentAvatarImageUrl) { cur.avatarImg = u.currentAvatarImageUrl; cur.avatarThumb = u.currentAvatarThumbnailImageUrl || u.currentAvatarImageUrl; }
  }
  const name = cur.name || prev?.name || "";
  let wrote = false;
  if (!silent && prev) {
    if (prev.name && cur.name && prev.name !== cur.name) { ins.flog.run(when, "DisplayName", uid, cur.name, prev.name, null, null, null); ins.fcur.run(uid, cur.name, cur.trust || prev.trust, 0); wrote = true; }
    if (prev.trust && cur.trust && prev.trust !== cur.trust) { ins.flog.run(when, "TrustLevel", uid, name, null, cur.trust, prev.trust, null); ins.fcur.run(uid, name, cur.trust, 0); wrote = true; }
    if (u && (prev.status !== cur.status || prev.statusText !== cur.statusText) && (u.status !== undefined || u.statusDescription !== undefined)) { ins.status.run(when, uid, name, cur.status, cur.statusText, prev.status, prev.statusText); wrote = true; }
    if (u && u.bio !== undefined && prev.bio !== undefined && prev.bio !== cur.bio) { ins.bio.run(when, uid, name, cur.bio, prev.bio); ins.profile.run(uid, cur.bio, JSON.stringify(u.bioLinks || []), when); wrote = true; }
    if (u && cur.avatarImg && prev.avatarImg && prev.avatarImg !== cur.avatarImg) {
      const info = await avatarNameFor(cur.avatarImg);
      ins.avatar.run(when, uid, name, info.owner, info.name, cur.avatarImg, cur.avatarThumb, prev.avatarImg, prev.avatarThumb); wrote = true;
    }
  } else if (u?.bio) ins.profile.run(uid, cur.bio, JSON.stringify(u.bioLinks || []), when);
  // online / offline / moving
  if (opts.online !== undefined || opts.location !== undefined) {
    const loc = opts.location ?? cur.location;
    const nowOnline = opts.online ?? isGameLoc(loc);
    if (nowOnline && !cur.online) {
      cur.online = true; cur.onlineAt = at; cur.locAt = at; cur.location = isGameLoc(loc) ? loc : "private";
      cur.worldName = loc.startsWith("wrld_") ? await worldNameAsync(loc.split(":")[0]) : "";
      if (!silent) { ins.oo.run(when, uid, name, "Online", cur.location, cur.worldName, null, groupOf(loc)); wrote = true; }
    } else if (!nowOnline && cur.online) {
      if (!silent) { ins.oo.run(when, uid, name, "Offline", cur.location, cur.worldName, cur.onlineAt ? at - cur.onlineAt : null, ""); wrote = true; }
      cur.online = false; cur.location = "offline"; cur.worldName = "";
    } else if (nowOnline && isGameLoc(loc) && !loc.startsWith("traveling") && loc !== cur.location) {
      const wn = loc.startsWith("wrld_") ? await worldNameAsync(loc.split(":")[0]) : "";
      if (!silent) { ins.gps.run(when, uid, name, loc, wn, cur.location, cur.locAt ? at - cur.locAt : null, groupOf(loc)); wrote = true; }
      cur.location = loc; cur.locAt = at; cur.worldName = wn;
    }
  }
  fstate.set(uid, cur); saveFs.run(uid, JSON.stringify(cur));
  if (wrote) { bump(); onFeedEvent(uid); }
}
let onFeedEvent = (uid: string) => {}; // alerts hook (set further down)

let nextFriendNumber = () => (((sdb.query("SELECT max(friend_number) m FROM friend_log_current").get() as any)?.m) || 0) + 1;
function friendAdded(uid: string, u: any, silent = false) {
  const exists = sdb.query("SELECT 1 FROM friend_log_current WHERE user_id = ?").get(uid);
  if (exists) return;
  const num = nextFriendNumber(), name = u?.displayName || "", trust = trustOf(u?.tags);
  sdb.query("INSERT OR IGNORE INTO friend_log_current(user_id, display_name, trust_level, friend_number) VALUES(?,?,?,?)").run(uid, name, trust, num);
  if (!silent) { ins.flog.run(iso(), "Friend", uid, name, null, trust, null, num); bump(); alertEvent("friendAdd", { uid, name }); }
}
function friendRemoved(uid: string) {
  const r = sdb.query("SELECT display_name, trust_level, friend_number FROM friend_log_current WHERE user_id = ?").get(uid) as any;
  if (!r) return;
  sdb.query("DELETE FROM friend_log_current WHERE user_id = ?").run(uid);
  ins.flog.run(iso(), "Unfriend", uid, r.display_name, null, r.trust_level, null, r.friend_number); bump();
}

// ---------- full friend sync ----------
let syncing = false, lastSync = 0;
let pendingIds = new Set<string>();
async function fullSync() {
  if (syncing || !session.auth) return;
  syncing = true;
  try {
    const me = await vrc("auth/user");
    if (me.status !== 200 || !me.body?.id) return;
    vrcUser = me.body; vrcUserAt = Date.now();
    if (me.body.id !== ME || !scfg("me")) { ME = me.body.id; setScfg("me", ME); }
    const seeding = fstate.size === 0;
    // seed Soul's friend list (keeps VRCX's friend numbers when available)
    const haveRoster = (sdb.query("SELECT count(*) c FROM friend_log_current").get() as any).c > 0;
    if (!haveRoster && VSRC && hasT(VSRC, "friend_log_current")) {
      const tx = sdb.transaction((rows: any[]) => { for (const r of rows) sdb.query("INSERT OR IGNORE INTO friend_log_current VALUES(?,?,?,?)").run(r.user_id, r.display_name, r.trust_level, r.friend_number); });
      tx(VSRC.db.query(`SELECT user_id, display_name, trust_level, friend_number FROM ${VSRC.P}friend_log_current`).all() as any[]);
    }
    const all = new Map<string, any>(), onlineMap = new Map<string, any>();
    for (const offline of [false, true]) {
      for (let off = 0; off < 5000; off += 100) {
        const r = await vrc(`auth/user/friends?offline=${offline}&n=100&offset=${off}`);
        if (r.status !== 200 || !Array.isArray(r.body)) { if (r.status === 401) vrcUser = null; return; }
        for (const f of r.body) { all.set(f.id, f); if (!offline) onlineMap.set(f.id, f); }
        if (r.body.length < 100) break;
      }
    }
    const ids: string[] = me.body.friends || [...all.keys()];
    const quiet = seeding || !haveRoster;
    for (const id of ids) friendAdded(id, all.get(id), quiet);
    // Unfriends: only log people VRChat no longer lists. On the very first sync (or if a huge
    // number vanish at once, which means VRChat's answer was incomplete) remove them quietly / not at all.
    const idSet = new Set([...ids, ...all.keys()]);
    const gone = (sdb.query("SELECT user_id FROM friend_log_current").all() as any[]).map((r) => r.user_id).filter((id) => !idSet.has(id));
    if (ids.length && gone.length) {
      if (quiet) { for (const id of gone) sdb.query("DELETE FROM friend_log_current WHERE user_id = ?").run(id); }
      else if (gone.length <= Math.max(5, ids.length * 0.1)) { for (const id of gone) friendRemoved(id); }
      else logErr(`Skipped ${gone.length} unfriends from an incomplete friend list`);
    }
    for (const [id, f] of all) {
      const loc = String(f.location || "offline");
      await applyFriend(id, f, { online: isGameLoc(loc), location: loc, silent: seeding });
      sdb.query("UPDATE friend_log_current SET display_name = ?, trust_level = ? WHERE user_id = ?").run(f.displayName, trustOf(f.tags), id);
    }
    const nr = await vrc("auth/user/notifications?n=100").catch(() => null);
    if (Array.isArray(nr?.body)) for (const n of nr.body) saveNotification(n, true);
    pendingIds = new Set(Array.isArray(nr?.body) ? nr.body.filter((n: any) => n.type === "friendRequest").map((n: any) => n.id) : []);
    live = { at: Date.now(), map: onlineMap }; liveVer++; liveErr = ""; lastSync = Date.now(); bump();
  } catch (e) { logErr(e); }
  finally { syncing = false; }
}

// ---------- VRChat live connection ----------
const PIPELINE = process.env.SOUL_VRC_PIPELINE || "wss://pipeline.vrchat.cloud/";
const pipe = { ws: null as WebSocket | null, connected: false, retry: 0, timer: null as any };
let evQueue: Promise<any> = Promise.resolve();
const enqueue = (fn: () => any) => { evQueue = evQueue.then(fn).catch(logErr); };
async function connectPipeline() {
  if (pipe.ws || !session.auth) return;
  const t = await vrc("auth").catch(() => null);
  if (!t || t.status !== 200 || !t.body?.token) { schedulePipeline(); return; }
  try {
    const ws = new WebSocket(`${PIPELINE}?auth=${t.body.token}`, { headers: { "User-Agent": UA } } as any);
    pipe.ws = ws;
    ws.onopen = () => { pipe.connected = true; pipe.retry = 0; liveVer++; fullSync(); };
    ws.onclose = () => { pipe.connected = false; pipe.ws = null; liveVer++; schedulePipeline(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
    let last = "";
    ws.onmessage = (ev) => {
      const data = String(ev.data);
      if (data === last) return; last = data;
      let msg: any; try { msg = JSON.parse(data); msg.content = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content; } catch { return; }
      enqueue(() => handlePipeline(msg.type, msg.content || {}));
    };
  } catch (e) { logErr(e); pipe.ws = null; schedulePipeline(); }
}
function schedulePipeline() {
  if (pipe.timer || !session.auth) return;
  pipe.retry = Math.min(pipe.retry + 1, 6);
  pipe.timer = setTimeout(() => { pipe.timer = null; connectPipeline(); }, 2000 * pipe.retry);
}
function closePipeline() { try { pipe.ws?.close(); } catch {} pipe.ws = null; pipe.connected = false; }
function liveSet(uid: string, patch: any) {
  if (!live) live = { at: Date.now(), map: new Map() };
  const cur = live.map.get(uid) || { id: uid };
  live.map.set(uid, { ...cur, ...patch }); live.at = Date.now(); liveVer++;
}
async function handlePipeline(type: string, c: any) {
  const uid = c.userId || c.user?.id;
  switch (type) {
    case "friend-online": {
      liveSet(uid, { ...(c.user || {}), location: c.location, platform: c.platform });
      const wasOnline = fstate.get(uid)?.online;
      await applyFriend(uid, c.user, { online: isGameLoc(c.location || "private") || c.location === "traveling", location: c.location || "private" });
      if (!wasOnline) alertEvent("online", { uid, name: c.user?.displayName || fstate.get(uid)?.name });
      break;
    }
    case "friend-active": liveSet(uid, { ...(c.user || {}), location: "offline", platform: c.platform }); await applyFriend(uid, c.user, { online: false }); break;
    case "friend-offline": if (live) { live.map.delete(uid); live.at = Date.now(); liveVer++; } await applyFriend(uid, null, { online: false }); break;
    case "friend-location": {
      const loc = c.location === "traveling" ? c.travelingToLocation || "traveling" : c.location;
      liveSet(uid, { ...(c.user || {}), location: loc });
      await applyFriend(uid, c.user, { online: true, location: loc });
      break;
    }
    case "friend-update": if (live?.map.has(uid)) liveSet(uid, c.user || {}); await applyFriend(uid, c.user); break;
    case "friend-add": friendAdded(uid, c.user); await applyFriend(uid, c.user, { silent: true }); break;
    case "friend-delete": friendRemoved(uid); if (live) { live.map.delete(uid); liveVer++; } break;
    case "notification": saveNotification(c); break;
    case "notification-v2": saveNotificationV2(c); break;
    case "user-update": if (c.user) { const before = vrcUser?.currentAvatar; vrcUser = { ...(vrcUser || {}), ...c.user }; if (c.user.currentAvatar && c.user.currentAvatar !== before) recordOwnAvatar(c.user.currentAvatar); liveVer++; } break;
  }
}
function saveNotification(n: any, quiet = false) {
  if (!n?.id) return;
  const isNew = !sdb.query("SELECT 1 FROM notifications WHERE id = ?").get(n.id);
  const d = typeof n.details === "string" ? (() => { try { return JSON.parse(n.details); } catch { return {}; } })() : n.details || {};
  sdb.query(`INSERT OR IGNORE INTO notifications(id, created_at, type, sender_user_id, sender_username, receiver_user_id, message, world_id, world_name, image_url, invite_message, request_message, response_message, expired)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(n.id, n.created_at || iso(), n.type, n.senderUserId || "", n.senderUsername || "", n.receiverUserId || ME, n.message || "",
    d.worldId || "", d.worldName || "", n.imageUrl || "", d.inviteMessage || "", d.requestMessage || "", d.responseMessage || "");
  bump(); if (!quiet && isNew) alertEvent("notification", { type: n.type, uid: n.senderUserId, name: n.senderUsername, world: d.worldName, location: d.worldId, message: n.message, id: n.id, text: d.requestMessage || d.inviteMessage || d.responseMessage || "" });
}
function saveNotificationV2(n: any) {
  if (!n?.id) return;
  sdb.query(`INSERT OR IGNORE INTO notifications_v2(id, created_at, updated_at, expires_at, type, link, link_text, message, title, image_url, seen, sender_user_id, sender_username, data, responses, details)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(n.id, n.createdAt || iso(), n.updatedAt || iso(), n.expiresAt || "", n.type || "", n.link || "", n.linkText || "", n.message || "", n.title || "",
    n.imageUrl || "", n.seen ? 1 : 0, n.senderUserId || "", n.senderUsername || "", JSON.stringify(n.data || {}), JSON.stringify(n.responses || []), JSON.stringify(n.details || {}));
  const uid = n.senderUserId || (String(n.link || "").startsWith("user:") ? String(n.link).slice(5) : "");
  bump(); alertEvent("notification", { type: n.type, uid, name: n.senderUsername || fstate.get(uid)?.name, title: n.title, message: n.message, id: n.id });
}
let ownAvatar = { id: "", at: 0 };
async function recordOwnAvatar(avatarId: string) {
  const now = Date.now();
  if (ownAvatar.id) sdb.query("UPDATE avatar_history SET time = coalesce(time,0) + ? WHERE avatar_id = ?").run(now - ownAvatar.at, ownAvatar.id);
  ownAvatar = { id: avatarId, at: now };
  sdb.query("INSERT INTO avatar_history(avatar_id, created_at, time) VALUES(?,?,0) ON CONFLICT(avatar_id) DO UPDATE SET created_at = excluded.created_at").run(avatarId, iso(now));
  if (!sdb.query("SELECT 1 FROM cache_avatar WHERE id = ?").get(avatarId)) {
    const a = await vrc(`avatars/${avatarId}`).catch(() => null);
    if (a?.status === 200) sdb.query(`INSERT OR REPLACE INTO cache_avatar(id, added_at, author_id, author_name, created_at, description, image_url, name, release_status, thumbnail_image_url, updated_at, version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(a.body.id, iso(), a.body.authorId, a.body.authorName, a.body.created_at, a.body.description, a.body.imageUrl, a.body.name, a.body.releaseStatus, a.body.thumbnailImageUrl, a.body.updated_at, a.body.version || 0);
  }
  bump();
}
function startRecorder() {
  if (!session.auth) return;
  connectPipeline();
  fullSync();
}
setInterval(() => { if (session.auth && Date.now() - lastSync > 10 * 60_000) fullSync(); if (session.auth && !pipe.ws && !pipe.timer) connectPipeline(); }, 60_000);

// ---------- VRChat's log files (worlds you visit, people you meet) ----------
const LOG_DIR = process.env.SOUL_VRC_LOGS || join(process.env.USERPROFILE || process.env.HOME || ".", "AppData", "LocalLow", "VRChat", "VRChat");
const logState = { files: new Map<string, number>(), till: "", loc: null as null | { id: number; at: number; location: string }, players: new Map<string, { at: number; name: string; uid: string }>(), worldName: "", lastAt: 0, busy: false };
{
  let till = "";
  for (const r of each(`SELECT max(created_at) m FROM gamelog_join_leave`).concat(each(`SELECT max(created_at) m FROM gamelog_location`))) if (r.m && r.m > till) till = r.m;
  logState.till = till;
  for (const r of sdb.query("SELECT key, value FROM configs WHERE key LIKE 'log:%'").all() as any[]) logState.files.set(r.key.slice(4), +r.value || 0);
}
const insLoc = sdb.query("INSERT OR IGNORE INTO gamelog_location(created_at, location, world_id, world_name, time, group_name) VALUES(?,?,?,?,0,'')");
const updLocTime = sdb.query("UPDATE gamelog_location SET time = ? WHERE id = ?");
const insJL = sdb.query("INSERT OR IGNORE INTO gamelog_join_leave(created_at, type, display_name, location, user_id, time) VALUES(?,?,?,?,?,?)");
const insVid = sdb.query("INSERT OR IGNORE INTO gamelog_video_play(created_at, video_url, video_name, video_id, location, display_name, user_id) VALUES(?,?,'','',?,'','')");
function logTime(line: string): number {
  const m = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(line);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
}
function parseUser(s: string) {
  const m = /^(.*?)\s*\((usr_[0-9a-f-]{36})\)\s*$/.exec(s.trim());
  return m ? { name: m[1], uid: m[2] } : { name: s.trim(), uid: "" };
}
function closeRoom(at: number) {
  const st = logState;
  if (!st.loc) return;
  const fresh = iso(at) > st.till;
  if (fresh) for (const p of st.players.values()) insJL.run(iso(at), "OnPlayerLeft", p.name, st.loc.location, p.uid, at - p.at);
  st.players.clear();
  if (fresh && st.loc.id) updLocTime.run(at - st.loc.at, st.loc.id);
  st.loc = null;
}
// Every line updates Soul's idea of where you are; only lines newer than what's already
// recorded (by Soul or VRCX) get written, so re-reading a log never duplicates anything.
function handleLogLine(line: string) {
  const at = logTime(line);
  if (!at) return;
  const st = logState;
  st.lastAt = at;
  const fresh = iso(at) > st.till;
  let i: number;
  if ((i = line.indexOf("[Behaviour] Entering Room: ")) >= 0) { st.worldName = line.slice(i + 27).trim(); return; }
  if ((i = line.indexOf("[Behaviour] Joining ")) >= 0 && !line.includes("Joining or Creating Room") && !line.includes("Joining friend")) {
    const location = line.slice(i + 20).trim().replace(/~nonce\([^)]*\)/, "");
    if (!location.startsWith("wrld_") && location !== "private") return;
    closeRoom(at);
    let id = 0;
    if (fresh) { const r = insLoc.run(iso(at), location, location.split(":")[0], st.worldName); id = Number(r.lastInsertRowid) || 0; bump(); }
    if (!id) id = (sdb.query("SELECT id FROM gamelog_location WHERE created_at = ? AND location = ?").get(iso(at), location) as any)?.id || 0;
    st.loc = { id, at, location };
    return;
  }
  if (line.includes("[Behaviour] OnLeftRoom")) { if (st.loc) { closeRoom(at); bump(); } return; }
  if ((i = line.indexOf("[Behaviour] OnPlayerJoined ")) >= 0 && !line.includes("OnPlayerJoined:")) {
    if (!st.loc) return;
    const u = parseUser(line.slice(i + 27));
    st.players.set(u.uid || u.name, { at, name: u.name, uid: u.uid });
    if (fresh) { insJL.run(iso(at), "OnPlayerJoined", u.name, st.loc.location, u.uid, 0); bump(); }
    return;
  }
  if ((i = line.indexOf("[Behaviour] OnPlayerLeft ")) >= 0 && !line.includes("OnPlayerLeftRoom") && !line.includes("OnPlayerLeft:")) {
    if (!st.loc) return;
    const u = parseUser(line.slice(i + 25));
    const p = st.players.get(u.uid || u.name);
    st.players.delete(u.uid || u.name);
    if (fresh) { insJL.run(iso(at), "OnPlayerLeft", u.name, st.loc.location, u.uid, p ? at - p.at : 0); bump(); }
    return;
  }
  if ((i = line.indexOf("[VRC Camera] Took screenshot to: ")) >= 0) {
    const path = line.slice(i + 33).trim();
    sdb.query("INSERT OR IGNORE INTO photos(path, created_at, location, world_name) VALUES(?,?,?,?)").run(path, iso(at), st.loc?.location || "", st.worldName || "");
    photoDirs.add(path.replace(/[\\/][^\\/]*$/, "").replace(/[\\/]\d{4}-\d{2}$/, ""));
    bump(); return;
  }
  if ((i = line.indexOf("[Video Playback] Attempting to resolve URL '")) >= 0) {
    if (!fresh) return;
    const url = line.slice(i + 44).replace(/'\s*$/, "");
    insVid.run(iso(at), url, st.loc?.location || ""); bump(); return;
  }
}
async function scanLogs() {
  if (logState.busy || !existsSync(LOG_DIR)) return;
  logState.busy = true;
  try {
    const files = readdirSync(LOG_DIR).filter((f) => /^output_log_.*\.txt$/.test(f)).sort();
    for (const f of files) {
      const path = join(LOG_DIR, f);
      const file = Bun.file(path);
      const size = file.size;
      const pos = logState.files.get(f) || 0;
      if (size <= pos) continue;
      const text = await file.slice(pos, size).text();
      const end = text.lastIndexOf("\n");
      if (end < 0) continue;
      const tx = sdb.transaction(() => { for (const line of text.slice(0, end).split(/\r?\n/)) if (line.length > 34) handleLogLine(line); });
      tx();
      const newPos = pos + Buffer.byteLength(text.slice(0, end + 1));
      logState.files.set(f, newPos); setScfg("log:" + f, String(newPos));
      // a finished log (VRChat closed) — close the room at the last line's time
      if (f !== files[files.length - 1] && logState.loc) { closeRoom(logState.lastAt); bump(); }
    }
  } catch (e) { logErr(e); }
  finally { logState.busy = false; }
}
// On startup re-read the newest log from the top so Soul knows where you are right now.
try {
  const newest = existsSync(LOG_DIR) ? readdirSync(LOG_DIR).filter((f) => /^output_log_.*\.txt$/.test(f)).sort().pop() : null;
  if (newest) logState.files.set(newest, 0);
} catch {}
setInterval(scanLogs, 3000);
setTimeout(scanLogs, 0);

// ===================================================================================
// ALERTS — pushed to the Soul window instantly; it shows them in-app and as Windows popups.
// ===================================================================================
const ALERT_DEFAULTS = { online: "favorites", invite: true, requestInvite: true, poke: true, friendRequest: true, friendAdd: true, groups: false, sound: true, popups: true };
function alertCfg(): typeof ALERT_DEFAULTS { try { return { ...ALERT_DEFAULTS, ...JSON.parse(scfg("alerts") || "{}") }; } catch { return { ...ALERT_DEFAULTS }; } }
let SERVER: any = null;
const recentAlerts: any[] = [];
let alertSeq = 0;
function pushAlert(a: any) {
  a.id = ++alertSeq; a.at = iso();
  recentAlerts.unshift(a); recentAlerts.length = Math.min(recentAlerts.length, 50);
  try { SERVER?.publish("alerts", JSON.stringify({ type: "alert", alert: a })); } catch (e) { logErr(e); }
  try { if (steamvr || process.env.SOUL_VR_TEST) vrAlert(a); } catch (e) { logErr(e); }
}
function picFor(uid: string) {
  const L = live?.map.get(uid);
  return L?.profilePicOverrideThumbnail || L?.userIcon || L?.currentAvatarThumbnailImageUrl || fstate.get(uid)?.avatarThumb || "";
}
let alertEvent = (kind: string, d: any) => {
  const c = alertCfg();
  const name = d.name || fstate.get(d.uid)?.name || "Someone";
  if (kind === "online") {
    if (c.online === "off" || (c.online === "favorites" && !favSet().has(d.uid))) return;
    const fs = fstate.get(d.uid);
    pushAlert({ kind, uid: d.uid, title: `${name} is online`, body: fs?.worldName ? `In ${fs.worldName}` : fs?.statusText || "Just came online", img: picFor(d.uid) });
  } else if (kind === "friendAdd") {
    if (!c.friendAdd) return;
    pushAlert({ kind, uid: d.uid, title: `You and ${name} are now friends`, body: "Friend request accepted", img: picFor(d.uid) });
  } else if (kind === "notification") {
    const t = String(d.type || "");
    if (t === "invite" && c.invite) pushAlert({ kind: "invite", uid: d.uid, title: `${name} invited you`, body: (d.text ? `“${d.text}” · ` : "") + (d.world ? `To ${d.world}` : "To their world"), location: d.location, img: picFor(d.uid) });
    else if (t === "requestInvite" && c.requestInvite) pushAlert({ kind: "requestInvite", uid: d.uid, title: d.text ? `💬 ${name}` : `${name} wants an invite`, body: d.text || "Asked to join you", img: picFor(d.uid) });
    else if ((t === "inviteResponse" || t === "requestInviteResponse") && d.text && c.requestInvite) pushAlert({ kind: "requestInvite", uid: d.uid, title: `💬 ${name} replied`, body: d.text, img: picFor(d.uid) });
    else if (t === "friendRequest" && c.friendRequest) pushAlert({ kind: "friendRequest", uid: d.uid, title: `${name} sent you a friend request`, body: "Open Notifications to see it", img: picFor(d.uid) });
    else if (t === "boop" && c.poke) pushAlert({ kind: "poke", uid: d.uid, title: `${name} poked you!`, body: d.title || "👉 Boop", img: picFor(d.uid) });
    else if (t.startsWith("group.") && c.groups) pushAlert({ kind: "group", uid: d.uid, title: d.title || "Group update", body: d.message || "", img: "" });
  }
};


// ---------- where am I right now (from VRChat's log) ----------
function myLocation(): string {
  const l = logState.loc;
  if (l && Date.now() - logState.lastAt < 6 * 3600_000 && l.location.startsWith("wrld_")) return l.location;
  const pres = vrcUser?.presence;
  if (pres?.world && pres?.instance && String(pres.world).startsWith("wrld_")) return `${pres.world}:${pres.instance}`;
  return "";
}
// ---------- start with Windows ----------
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
function startupOn(): boolean {
  if (process.platform !== "win32") return false;
  try { const r = Bun.spawnSync(["reg", "query", RUN_KEY, "/v", "Soul"], { windowsHide: true } as any); return r.exitCode === 0; } catch { return false; }
}
function setStartup(on: boolean): boolean {
  if (process.platform !== "win32") return false;
  try {
    const r = on
      ? Bun.spawnSync(["reg", "add", RUN_KEY, "/v", "Soul", "/t", "REG_SZ", "/d", `"${process.execPath}" --background`, "/f"], { windowsHide: true } as any)
      : Bun.spawnSync(["reg", "delete", RUN_KEY, "/v", "Soul", "/f"], { windowsHide: true } as any);
    return r.exitCode === 0;
  } catch (e) { logErr(e); return false; }
}

// ===================================================================================
// WHERE YOU ARE · WORLDS · GROUPS · PHOTOS · MUTUALS · BACKUP
// ===================================================================================
function whereAmI() {
  const l = logState.loc;
  const fresh = l && Date.now() - logState.lastAt < 12 * 3600_000;
  if (!l || !fresh) return { inWorld: false };
  const favs = favSet(), fr = new Set(friendRoster().map((r) => r.user_id));
  const players = [...logState.players.values()].filter((p) => p.uid !== ME).map((p) => ({ id: p.uid, name: p.name, since: iso(p.at), friend: fr.has(p.uid), fav: favs.has(p.uid) }))
    .sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || (b.friend ? 1 : 0) - (a.friend ? 1 : 0) || a.name.localeCompare(b.name));
  const wid = l.location.split(":")[0];
  const sameWorld = friends().filter((f) => f.online && f.location.startsWith(wid + ":") && f.location !== l.location).map((f) => ({ id: f.id, name: f.name, location: f.location }));
  return { inWorld: true, location: l.location, worldId: wid, worldName: logState.worldName || worldName(wid), since: iso(l.at), players, sameWorld, world: worldInfoCache.get(wid) || null };
}
const worldInfoCache = new Map<string, any>();
function mapWorld(w: any) {
  return { id: w.id, name: w.name, author: w.authorName, authorId: w.authorId, thumb: w.thumbnailImageUrl, image: w.imageUrl, capacity: w.capacity, occupants: w.occupants ?? (w.publicOccupants || 0) + (w.privateOccupants || 0),
    favorites: w.favorites, visits: w.visits, description: w.description || "", tags: (w.tags || []).filter((t: string) => t.startsWith("author_tag_")).map((t: string) => t.slice(11)),
    instances: (w.instances || []).map((i: any) => ({ id: i[0], users: i[1], location: `${w.id}:${i[0]}` })), updated: w.updated_at, platforms: [...new Set((w.unityPackages || []).map((u: any) => u.platform))] };
}
async function worldDetails(wid: string) {
  const c = worldInfoCache.get(wid);
  if (c && Date.now() - c._at < 5 * 60_000) return c;
  const r = await vrc(`worlds/${wid}`);
  if (r.status !== 200) return { error: vrcError(r) };
  const w = { ...mapWorld(r.body), _at: Date.now() };
  worldInfoCache.set(wid, w); worldNames.set(wid, w.name);
  return w;
}
// photos: VRChat's screenshot folders
const photoDirs = new Set<string>();
function addDefaultPhotoDirs() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  for (const d of [join(home, "Pictures", "VRChat"), join(home, "OneDrive", "Pictures", "VRChat"), process.env.SOUL_PHOTOS || ""]) if (d) photoDirs.add(d);
  if (process.platform === "win32") {
    try {
      const r = Bun.spawnSync(["reg", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders", "/v", "My Pictures"], { windowsHide: true } as any);
      const m = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(r.stdout.toString());
      if (m) photoDirs.add(join(m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] || ""), "VRChat"));
    } catch {}
  }
  for (const r of sdb.query("SELECT DISTINCT path FROM photos").all() as any[]) photoDirs.add(String(r.path).replace(/[\\/][^\\/]*$/, "").replace(/[\\/]\d{4}-\d{2}$/, ""));
}
addDefaultPhotoDirs();
function listPhotos(): { path: string; at: number }[] {
  const out: { path: string; at: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let ents: any[] = []; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (/\.(png|jpe?g|webp)$/i.test(e.name) && /^VRChat_/i.test(e.name)) { try { out.push({ path: p, at: statSync(p).mtimeMs }); } catch {} }
    }
  };
  for (const d of photoDirs) walk(d, 0);
  return dedupe(out, (x) => x.path.toLowerCase()).sort((a, b) => b.at - a.at);
}
function photoAllowed(p: string) { const n = p.toLowerCase(); return [...photoDirs].some((d) => n.startsWith(d.toLowerCase())) && /\.(png|jpe?g|webp)$/i.test(p); }
function photoTimeFromName(p: string, fallback: number) {
  const m = /VRChat_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(p);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : fallback;
}
function photoInfo(path: string, atMs: number) {
  const rec = sdb.query("SELECT location, world_name FROM photos WHERE path = ?").get(path) as any;
  const t = iso(photoTimeFromName(path, atMs));
  let visit: any = null;
  if (rec?.location) visit = { location: rec.location, name: rec.world_name };
  else for (const v of worlds().visits) { if (v.at <= t && new Date(v.at).getTime() + (+v.time || 12 * 3600_000) >= new Date(t).getTime()) { visit = { location: v.location, name: v.name, at: v.at }; break; } }
  let people: any[] = [];
  if (visit?.location) {
    const rows = dedupe(each(`SELECT created_at, type, user_id, display_name FROM gamelog_join_leave WHERE location = ? AND created_at <= ? ORDER BY created_at`, visit.location, t), (r) => r.created_at + r.type + (r.user_id || r.display_name));
    const here = new Map<string, any>();
    for (const r of rows) { const k = r.user_id || r.display_name; if (r.type === "OnPlayerJoined") here.set(k, { id: r.user_id, name: r.display_name }); else here.delete(k); }
    people = [...here.values()].filter((p) => p.id !== ME);
  }
  return { at: t, world: visit?.name || "", location: visit?.location || "", people };
}
// export helpers
function toCsv(rows: any[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]).filter((c) => c !== "_src" && c !== "key");
  const cell = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}

// ===================================================================================
// VR — SteamVR overlay (wrist panel + alert popups), XSOverlay and OVR Toolkit alerts
// ===================================================================================
const VR_DEFAULTS = { enabled: true, hand: "left", wrist: true, hud: true, xso: false, ovrt: false };
function vrCfg(): typeof VR_DEFAULTS { try { return { ...VR_DEFAULTS, ...JSON.parse(scfg("vr") || "{}") }; } catch { return { ...VR_DEFAULTS }; } }
let PORT = 7317, steamvr = false, overlayProc: any = null, overlayExit = "";
const frames: Record<string, { buf: Uint8Array; w: number; h: number; ver: number; until: number }> = {};
let frameVer = 0;
const IS_DEV = /bun(\.exe)?$/i.test(process.execPath);
function checkSteamVR() {
  if (process.platform !== "win32") return;
  try {
    const out = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq vrserver.exe", "/NH"], { windowsHide: true } as any).stdout.toString();
    steamvr = /vrserver\.exe/i.test(out);
  } catch { steamvr = false; }
  const c = vrCfg();
  if (steamvr && c.enabled && (c.wrist || c.hud) && !overlayProc) {
    try {
      overlayProc = Bun.spawn([...(IS_DEV ? [process.execPath, Bun.main] : [process.execPath]), "--overlay", `--port=${PORT}`], { windowsHide: true, stdout: "ignore", stderr: "ignore" } as any);
      overlayProc.exited.then((code: number) => { overlayExit = code === 2 ? "SteamVR wouldn't start the overlay" : code ? `overlay stopped (${code})` : ""; overlayProc = null; });
    } catch (e) { logErr(e); overlayProc = null; }
  }
  if ((!steamvr || !c.enabled) && overlayProc) { try { overlayProc.kill(); } catch {} overlayProc = null; }
}
setInterval(checkSteamVR, 10_000);
setTimeout(checkSteamVR, 3000);
process.on("exit", () => { try { overlayProc?.kill(); } catch {} });

const udp = dgram.createSocket("udp4");
let ovrtWs: WebSocket | null = null;
function vrAlert(a: any) {
  const c = vrCfg();
  if (c.xso) {
    const msg = JSON.stringify({ messageType: 1, index: 0, title: a.title, content: a.body || "", height: 110, sourceApp: "Soul", timeout: 5, audioPath: "", useBase64Icon: false, icon: "default", opacity: 1, volume: 0.6 });
    try { udp.send(msg, 42069, "127.0.0.1"); } catch {}
  }
  if (c.ovrt) {
    const send = () => { try { ovrtWs?.send(JSON.stringify({ messageType: "SendNotification", json: JSON.stringify({ title: a.title, body: a.body || "" }) })); } catch {} };
    if (ovrtWs && ovrtWs.readyState === 1) send();
    else { try { ovrtWs = new WebSocket("ws://127.0.0.1:11450/api"); ovrtWs.onopen = send; ovrtWs.onerror = () => { ovrtWs = null; }; } catch {} }
  }
}

// ===================================================================================
// PHONE VIEW — Soul on your phone over your home Wi-Fi, protected by a secret link
// ===================================================================================
const PHONE_BLOCKED = new Set(["/api/update", "/api/quit", "/api/backup", "/api/startup", "/api/phone", "/api/vrc/logout"]);
function phoneCfg(): { enabled: boolean; key: string } {
  let c: any = {}; try { c = JSON.parse(scfg("phone") || "{}"); } catch {}
  if (!c.key) { c.key = randomBytes(18).toString("base64url"); setScfg("phone", JSON.stringify(c)); }
  return { enabled: !!c.enabled, key: c.key };
}
function lanIp(): string {
  const all = Object.values(networkInterfaces()).flat().filter((i: any) => i && i.family === "IPv4" && !i.internal) as any[];
  const pick = all.find((i) => /^192\.168\./.test(i.address)) || all.find((i) => /^10\./.test(i.address)) || all.find((i) => /^172\.(1[6-9]|2\d|3[01])\./.test(i.address)) || all[0];
  return pick?.address || "";
}
let phoneServer: any = null, phonePort = 0, phoneErr = "";
function phoneUrl() { const c = phoneCfg(); const ip = lanIp(); return ip && phonePort ? `http://${ip}:${phonePort}/?key=${c.key}` : ""; }
function phoneHandle(req: Request, server: any) {
  const url = new URL(req.url), c = phoneCfg();
  const cookieKey = (req.headers.get("cookie") || "").match(/soul_key=([\w-]+)/)?.[1];
  const key = url.searchParams.get("key") || cookieKey;
  if (key !== c.key) return new Response(`<body style="font-family:system-ui;background:#0d0c16;color:#eee;padding:30px"><h2>👻 Soul</h2><p>Open the phone link from Soul's Settings on your PC (or scan its QR code).</p></body>`, { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
  if (PHONE_BLOCKED.has(url.pathname)) return json({ error: "Not available from your phone." }, 403);
  if (url.pathname === "/ws") { if (server.upgrade(req, { data: { phone: true } })) return undefined; }
  const res: any = handle(req, server);
  const setCookie = (r: Response) => { if (url.searchParams.get("key")) r.headers.append("set-cookie", `soul_key=${c.key}; Path=/; Max-Age=31536000; SameSite=Strict`); return r; };
  return res instanceof Promise ? res.then(setCookie) : res ? setCookie(res) : res;
}
function startPhone() {
  const c = phoneCfg();
  if (!c.enabled) { if (phoneServer) { try { phoneServer.stop(true); } catch {} phoneServer = null; phonePort = 0; } return; }
  if (phoneServer) return;
  for (let port = PORT + 1; port < PORT + 20; port++) {
    try { phoneServer = Bun.serve({ port, hostname: "0.0.0.0", fetch: phoneHandle as any, websocket: { ...presence, idleTimeout: 0 } as any, idleTimeout: 60, maxRequestBodySize: 50 * 1024 * 1024 }); phonePort = port; phoneErr = ""; return; }
    catch (e: any) { phoneErr = String(e?.message || e); }
  }
}

// ===================================================================================
// UPDATES — new versions are published at github.com/rpantojasphs-star/soul/releases
// ===================================================================================
const UPDATE_REPO = process.env.SOUL_UPDATE_REPO || "rpantojasphs-star/soul";
const UPDATE_API = process.env.SOUL_UPDATE_API || "https://api.github.com";
const upd: any = { checkedAt: 0, latest: null, notes: "", asset: null, available: false, state: "idle", progress: 0, error: "" };
const verNum = (v: string) => (String(v).replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((x) => parseInt(x) || 0));
const newer = (a: string, b: string) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
async function checkUpdate() {
  try {
    const r = await fetch(`${UPDATE_API}/repos/${UPDATE_REPO}/releases/latest`, { headers: { "User-Agent": UA, Accept: "application/vnd.github+json" } });
    upd.checkedAt = Date.now();
    if (r.status === 404) { upd.error = "No releases published yet."; return; }
    if (!r.ok) { upd.error = `GitHub said ${r.status}`; return; }
    const j: any = await r.json();
    upd.latest = String(j.tag_name || "").replace(/^v/i, ""); upd.notes = j.body || ""; upd.url = j.html_url;
    upd.asset = (j.assets || []).find((a: any) => /^soul\.exe$/i.test(a.name)) || null;
    upd.available = !!upd.latest && newer(upd.latest, VERSION) && !!upd.asset;
    upd.error = "";
  } catch (e: any) { upd.error = "Couldn't reach GitHub."; }
}
async function installUpdate() {
  if (upd.state === "downloading" || upd.state === "restarting" || upd.state === "installed") return;
  if (!upd.available || !upd.asset) return void (upd.error = "No update to install.");
  if ((process.platform !== "win32" && !process.env.SOUL_UPDATE_TEST) || IS_DEV) return void (upd.error = "Updates install on the Windows app only.");
  const dir = dirname(process.execPath), cur = process.execPath, tmp = join(dir, "Soul.new.exe");
  let old = join(dir, "Soul.old.exe");
  try {
    upd.state = "downloading"; upd.progress = 0; upd.error = "";
    const r = await fetch(upd.asset.browser_download_url, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
    const total = +(r.headers.get("content-length") || upd.asset.size || 0);
    const w = Bun.file(tmp).writer(); let got = 0;
    for await (const chunk of r.body as any) { w.write(chunk); got += chunk.length; upd.progress = total ? got / total : 0; }
    await w.end();
    if (upd.asset.size && statSync(tmp).size !== upd.asset.size) throw new Error("the download was incomplete");
    upd.state = "restarting";
    // an older copy may still be in use (e.g. a half-finished update) — then pick a fresh name
    try { if (existsSync(old)) unlinkSync(old); } catch { old = join(dir, `Soul.old-${Date.now()}.exe`); }
    renameSync(cur, old);       // Windows lets a running program be renamed
    try { renameSync(tmp, cur); } catch (e) { renameSync(old, cur); throw e; }
    if (process.platform !== "win32") { try { (await import("node:fs")).chmodSync(cur, 0o755); } catch {} }
    // Start the new version; it takes over from this one and the open window reloads into it.
    // Right after download, Windows Defender is often still scanning the new file and Windows
    // refuses to start it ("EBUSY"), so keep trying for up to ~45 seconds.
    let started = false, lastErr: any = null;
    for (let i = 0; i < 30 && !started; i++) {
      try { Bun.spawn([cur, "--background"], { windowsHide: true, stdout: "ignore", stderr: "ignore", detached: true } as any).unref?.(); started = true; }
      catch (e) { lastErr = e; await Bun.sleep(1500); }
    }
    if (!started) { upd.state = "installed"; upd.error = ""; logErr(lastErr); return; }
  } catch (e: any) {
    upd.state = "idle"; upd.error = "Update failed: " + (e?.message || e);
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    try { if (!existsSync(cur) && existsSync(old)) renameSync(old, cur); } catch {}
  }
}
// clean up the previous version after an update
if (!IS_DEV) setTimeout(() => { try { const d = dirname(process.execPath); for (const f of readdirSync(d)) if (/^Soul\.(old(-\d+)?|new)\.exe$/i.test(f) && join(d, f) !== process.execPath) { try { unlinkSync(join(d, f)); } catch {} } } catch {} }, 5000);
setTimeout(checkUpdate, 15_000);
setInterval(checkUpdate, 6 * 3600_000);
// ---------- messages ----------
// VRChat has no direct messages. Soul sends your text as an invite request ("X asked to join
// you: <your text>"), which pops up for your friend in VRChat. The text goes into one of your 12
// saved request messages; VRChat lets each one be changed about once an hour, so Soul reuses a
// slot that already has the same text, otherwise the one changed longest ago.
const MSG_MAX = 64;
sdb.run("CREATE TABLE IF NOT EXISTS soul_messages (id INTEGER PRIMARY KEY, user_id TEXT, text TEXT, at TEXT)");
let lastChat = 0;
async function msgSlots() {
  const r = await vrc(`message/${ME}/request`);
  if (r.status !== 200 || !Array.isArray(r.body)) return { error: vrcError(r) };
  const slots = r.body.map((m: any) => ({ slot: m.slot, message: m.message || "", wait: Math.max(0, +m.remainingCooldownMinutes || 0), updated: m.updatedAt || "" }));
  const free = slots.filter((m: any) => !m.wait).length;
  return { slots, free, nextFree: free ? 0 : Math.min(...slots.map((m: any) => m.wait)) };
}
async function sendChat(uid: string, text: string) {
  text = String(text || "").replace(/\s+/g, " ").trim();
  if (!/^usr_[0-9a-f-]{36}$/.test(uid)) return { ok: false, error: "That isn't a valid user." };
  if (!text) return { ok: false, error: "Type a message first." };
  if (text.length > MSG_MAX) return { ok: false, error: `VRChat only allows ${MSG_MAX} characters.` };
  if (Date.now() - lastChat < 2500) return { ok: false, error: "Slow down a little — one message every few seconds." };
  lastChat = Date.now();
  const st: any = await msgSlots();
  if (st.error) return { ok: false, error: st.error };
  let slot = st.slots.find((m: any) => m.message === text);
  if (!slot) {
    // empty slots first, then ones Soul filled before, then the one changed longest ago
    const mine = new Set((sdb.query("SELECT DISTINCT text FROM soul_messages").all() as any[]).map((r) => r.text));
    const rank = (m: any) => (!m.message ? 0 : mine.has(m.message) ? 1 : 2);
    const free = st.slots.filter((m: any) => !m.wait).sort((a: any, b: any) => rank(a) - rank(b) || (a.updated < b.updated ? -1 : 1));
    if (!free.length) return { ok: false, error: `VRChat only lets you send ${st.slots.length} different messages an hour. You can send a new one in ${st.nextFree} min — or resend one you already sent.` };
    slot = free[0];
    const u = await vrc(`message/${ME}/request/${slot.slot}`, { method: "PUT", body: JSON.stringify({ message: text }) });
    if (u.status !== 200) return { ok: false, error: u.status === 403 || u.status === 401 ? "Sending your own words needs VRC+. " + vrcError(u) : vrcError(u) };
  }
  const r = await vrc(`requestInvite/${uid}`, { method: "POST", body: JSON.stringify({ requestSlot: slot.slot }) });
  if (r.status !== 200) return { ok: false, error: vrcError(r) };
  sdb.query("INSERT INTO soul_messages(user_id, text, at) VALUES(?,?,?)").run(uid, text, iso()); bump();
  return { ok: true };
}
function chatThread(uid: string) {
  const out = (sdb.query("SELECT text, at FROM soul_messages WHERE user_id = ? ORDER BY at DESC LIMIT 200").all(uid) as any[]).map((m) => ({ dir: "out", text: m.text, at: m.at }));
  const KIND: Record<string, string> = { invite: "invited you", requestInvite: "asked to join you", inviteResponse: "replied", requestInviteResponse: "replied", boop: "poked you" };
  const inc = notifications().filter((n: any) => n.uid === uid && KIND[n.type]).slice(0, 200).map((n: any) => ({ dir: "in", at: n.at, kind: KIND[n.type],
    text: n.requestMsg || n.inviteMsg || n.responseMsg || (n.type === "boop" ? n.title || "👉" : ""), world: n.type === "invite" ? n.world || "" : "", location: n.type === "invite" ? n.location || "" : "" }));
  return [...out, ...inc].sort((a, b) => (a.at < b.at ? -1 : 1)).slice(-150);
}
// ---------- server ----------
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

// ---------- close window = quit, minimize = keep running ----------
// Each open Soul window holds a live connection. When the last one goes away (you closed the
// window), Soul waits a few seconds in case it was just a reload, then exits.
let windows = 0, everConnected = false, quitTimer: any = null;
const presence = {
  open(ws: any) { try { ws.subscribe("alerts"); } catch {} if (ws.data?.phone) return; windows++; everConnected = true; if (quitTimer) { clearTimeout(quitTimer); quitTimer = null; } },
  message() {},
  close(ws: any) {
    if (ws?.data?.phone) return;
    windows = Math.max(0, windows - 1);
    if (windows === 0 && everConnected && process.env.SOUL_STAY !== "1") {
      quitTimer = setTimeout(() => { if (windows === 0) process.exit(0); }, 6000);
    }
  },
};

function handle(req: Request, server?: any): Response | Promise<Response> | undefined {
  const url = new URL(req.url);
  const p = url.pathname;
  const s = url.searchParams;
  try {
    if (p === "/ws" && server?.upgrade(req)) return undefined;
    if (p === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (p === "/api/ping") return json({ app: "soul", version: VERSION });
    if (p === "/api/meta") return json({ me: ME, myName: myName(), dbPath: DB_PATH, vrcx: !!VSRC, version: VERSION, dataVersion: dataVersion(), latest: latestActivity(), dataDir: DATA_DIR });
    if (p === "/api/poll") { if (session.auth && liveStale() && !pipe.connected) refreshLive(); return json({ version: VERSION, update: upd.available ? upd.latest : null, vr: { steamvr, overlay: !!overlayProc }, live: live ? { at: new Date(live.at).toISOString(), count: [...live.map.values()].filter((f) => f.location !== "offline").length } : null, pipeline: pipe.connected, recording: { logs: existsSync(LOG_DIR), vrcx: !!VSRC, vrcxLatest: cached("vrcxLatest", lastVrcxActivity) }, liveErr, dataVersion: dataVersion(), latest: cached("latest", latestActivity) }); }
    if (p === "/api/friends") return json(friends());
    if (p === "/api/feed") {
      const kinds = (s.get("kinds") || Object.keys(FEEDS).join(",")).split(",").filter(Boolean);
      return json(feed({ kinds, q: s.get("q") || undefined, before: s.get("before") || undefined, user: s.get("user") || undefined, limit: Math.min(+(s.get("limit") || 100), 500) }));
    }
    if (p === "/api/friendlog") return json(friendLog());
    if (p === "/api/worlds") return json(worlds());
    if (p === "/api/instance") return json(instancePeople(s.get("location") || "", s.get("from") || "", +(s.get("ms") || 0)));
    if (p === "/api/notifications") return json(notifications());
    if (p === "/api/user") return json(user(s.get("id") || ""));
    if (p === "/api/vrc/status" && req.method === "GET") { if (s.get("fresh")) vrcUserAt = 0; return vrcStatus().then(json); }
    if (p === "/api/vrc/login" && req.method === "POST") {
      return req.json().then(async ({ username, password }: any) => {
        if (!username || !password) return json({ ok: false, error: "Enter your username and password." });
        session = {}; saveSession(); vrcUser = null;
        const basic = btoa(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`);
        return json(loginResult(await vrc("auth/user", { headers: { Authorization: `Basic ${basic}` } })));
      });
    }
    if (p === "/api/vrc/2fa" && req.method === "POST") {
      return req.json().then(async ({ code, type }: any) => {
        const ep = type === "emailOtp" ? "emailotp" : String(code).replace(/\s/g, "").length > 6 ? "otp" : "totp";
        const v = await vrc(`auth/twofactorauth/${ep}/verify`, { method: "POST", body: JSON.stringify({ code: String(code).trim() }) });
        if (v.status !== 200 || v.body?.verified === false) return json({ ok: false, error: v.status === 200 ? "That code didn't work." : vrcError(v) });
        return json(loginResult(await vrc("auth/user")));
      });
    }
    if (p === "/api/vrc/logout" && req.method === "POST") {
      return vrc("logout", { method: "PUT" }).catch(() => null).then(() => { closePipeline(); session = {}; saveSession(); vrcUser = null; live = null; liveVer++; return json({ ok: true }); });
    }
    if (p === "/api/vrc/boop" && req.method === "POST") return req.json().then(({ userId, emojiId }: any) => sendBoop(userId, emojiId)).then(json);
    if (p === "/api/vrc/emojis") {
      return Promise.all([vrc("files?n=100&tag=emoji"), vrc("files?n=100&tag=emojianimated")]).then(([a, b]) => ({ status: 200, body: [...(Array.isArray(a.body) ? a.body : []), ...(Array.isArray(b.body) ? b.body : [])].sort((x: any, y: any) => (x.created_at < y.created_at ? 1 : -1)) })).then((r) => json(Array.isArray(r.body) ? r.body.map((f: any) => {
        const v = f.versions?.[f.versions.length - 1]; if (!v?.file?.url) return null;
        return { id: f.id, name: f.name, url: v.file.url, frames: f.frames || 0, fps: f.framesOverTime || 0, loop: f.loopStyle || "linear", effect: f.animationStyle || "", mask: f.maskTag || "square" };
      }).filter(Boolean) : []));
    }
    if (p === "/api/vrc/emoji" && req.method === "POST") {
      // the page sends a ready-made square PNG (or animated sprite sheet) plus its settings
      return req.formData().then(async (fd) => {
        const file = fd.get("file") as unknown as Blob | null;
        if (!file) return json({ ok: false, error: "No image." });
        if (file.size > 10_000_000) return json({ ok: false, error: "That image is over 10 MB." });
        const out = new FormData();
        const frames = +(fd.get("frames") || 0);
        out.append("tag", frames > 1 ? "emojianimated" : "emoji");
        const allowed = (v: any, list: string[], d: string) => (list.includes(String(v)) ? String(v) : d);
        out.append("animationStyle", allowed(fd.get("animationStyle"), ["aura","bats","bees","bounce","cloud","confetti","crying","dislike","fire","idea","lasers","like","magnet","mistletoe","money","noise","orbit","pizza","rain","rotate","shake","snow","snowball","spin","splash","stop","zzz"], "bounce"));
        out.append("maskTag", allowed(fd.get("maskTag"), ["square","circle","heart","star","flower","pow"], "square"));
        if (frames > 1) {
          out.append("frames", String(Math.min(64, Math.max(2, frames))));
          out.append("framesOverTime", String(Math.min(64, Math.max(1, +(fd.get("fps") || 12)))));
          out.append("loopStyle", fd.get("loopStyle") === "pingpong" ? "pingpong" : "linear");
        }
        out.append("file", new Blob([await file.arrayBuffer()], { type: "image/png" }), "blob");
        const r = await vrc("file/image", { method: "POST", body: out as any });
        return json(r.status === 200 ? { ok: true, id: r.body?.id } : { ok: false, status: r.status, error: vrcError(r) });
      });
    }
    if (p === "/api/vrc/emoji/delete" && req.method === "POST") {
      return req.json().then(async ({ id }: any) => {
        if (!/^file_[0-9a-f-]{36}$/.test(id || "")) return json({ ok: false, error: "Bad emoji id." });
        const r = await vrc(`file/${id}`, { method: "DELETE" });
        return json(r.status === 200 ? { ok: true } : { ok: false, error: vrcError(r) });
      });
    }
    if (p === "/api/vrc/user") {
      const id = s.get("id") || "";
      if (!/^usr_[0-9a-f-]{36}$/.test(id)) return json({ error: "bad id" }, 400);
      if (!session.auth) return json({ error: "signed out", status: 401 });
      return vrcUserInfo(id).then(json);
    }
    if (p === "/api/vrc/avatarinfo") {
      const img = s.get("img") || "", id = s.get("id") || "";
      if (img && !/^https:\/\/([a-z0-9-]+\.)*vrchat\.(cloud|com)\//i.test(img)) return json({ error: "bad image" }, 400);
      if (!session.auth) return json({ error: "Sign in to VRChat to see avatar details." });
      return avatarInfo(img, /^avtr_[0-9a-f-]{36}$/.test(id) ? id : "").then(json);
    }
    if (p === "/api/vrc/img") {
      const u = s.get("u") || "";
      const okHost = /^https:\/\/([a-z0-9-]+\.)*(vrchat\.cloud|vrchat\.com)\//i.test(u);
      if (!okHost) return new Response("bad", { status: 400 });
      const isApi = /^https:\/\/api\.vrchat\.cloud\//.test(u);
      return fetch(u, { headers: isApi ? { "User-Agent": UA, Cookie: cookieHeader() } : { "User-Agent": UA } }).then((r) => new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "image/png", "cache-control": "max-age=86400" } }));
    }
    if (p === "/api/fav" && req.method === "POST") return req.json().then(({ id, on }: any) => {
      if (!/^usr_[0-9a-f-]{36}$/.test(id || "")) return json({ ok: false }, 400);
      if (on) sdb.query("INSERT OR IGNORE INTO favorites(user_id, created_at) VALUES(?, ?)").run(id, iso()); else sdb.query("DELETE FROM favorites WHERE user_id = ?").run(id);
      bump(); return json({ ok: true });
    });
    if (p === "/api/fav/import" && req.method === "POST") {
      // copy the friends you've favorited inside VRChat
      return (async () => {
        let n = 0;
        for (let off = 0; off < 1000; off += 100) {
          const r = await vrc(`favorites?type=friend&n=100&offset=${off}`);
          if (r.status !== 200 || !Array.isArray(r.body)) return json({ ok: false, error: vrcError(r) });
          for (const f of r.body) if (f.favoriteId) { sdb.query("INSERT OR IGNORE INTO favorites(user_id, created_at) VALUES(?, ?)").run(f.favoriteId, iso()); n++; }
          if (r.body.length < 100) break;
        }
        bump(); return json({ ok: true, count: n });
      })();
    }
    // ---------- friend requests ----------
    if (p === "/api/vrc/friendRequest" && req.method === "POST") return req.json().then(async ({ id, accept }: any) => {
      if (!/^not_[0-9a-f-]{36}$/.test(id || "")) return json({ ok: false, error: "Bad request id." });
      const r = await vrc(`auth/user/notifications/${id}/${accept ? "accept" : "hide"}`, { method: "PUT" });
      if (r.status !== 200) return json({ ok: false, error: vrcError(r) });
      sdb.query("INSERT OR REPLACE INTO notif_state(id, state, at) VALUES(?,?,?)").run(id, accept ? "accepted" : "declined", iso()); pendingIds.delete(id); bump();
      if (accept) setTimeout(fullSync, 1500);
      return json({ ok: true });
    });
    // ---------- people search + friending ----------
    if (p === "/api/vrc/users/search") {
      const q = (s.get("q") || "").trim().slice(0, 64), off = Math.max(0, Math.min(900, +(s.get("offset") || 0)));
      if (!q) return json([]);
      if (/^usr_[0-9a-f-]{36}$/.test(q)) return vrc(`users/${q}`).then((r) => json(r.status === 200 ? [personRow(r.body)] : []));
      return vrc(`users?search=${encodeURIComponent(q)}&n=40&offset=${off}`).then((r) => json(Array.isArray(r.body) ? r.body.map(personRow) : { error: vrcError(r) }));
    }
    if (p === "/api/vrc/friendStatus") {
      const id = s.get("id") || "";
      if (!/^usr_[0-9a-f-]{36}$/.test(id)) return json({ error: "bad id" }, 400);
      if (id === ME) return json({ self: true });
      return vrc(`user/${id}/friendStatus`).then((r) => json(r.status === 200 ? { isFriend: !!r.body.isFriend, outgoing: !!r.body.outgoingRequest, incoming: !!r.body.incomingRequest } : { error: vrcError(r) }));
    }
    if (p === "/api/vrc/friend" && req.method === "POST") return req.json().then(async ({ id, action }: any) => {
      if (!/^usr_[0-9a-f-]{36}$/.test(id || "") || id === ME) return json({ ok: false, error: "That isn't a valid user." });
      let r;
      if (action === "add") r = await vrc(`user/${id}/friendRequest`, { method: "POST" });
      else if (action === "cancel") r = await vrc(`user/${id}/friendRequest`, { method: "DELETE" });
      else if (action === "unfriend") r = await vrc(`auth/user/friends/${id}`, { method: "DELETE" });
      else if (action === "accept") {
        const n = await vrc("auth/user/notifications?type=friendRequest&n=100");
        const req2 = Array.isArray(n.body) ? n.body.find((x: any) => x.senderUserId === id) : null;
        r = req2 ? await vrc(`auth/user/notifications/${req2.id}/accept`, { method: "PUT" }) : await vrc(`user/${id}/friendRequest`, { method: "POST" });
        if (req2 && r.status === 200) { sdb.query("INSERT OR REPLACE INTO notif_state(id, state, at) VALUES(?,?,?)").run(req2.id, "accepted", iso()); pendingIds.delete(req2.id); }
      } else return json({ ok: false, error: "Unknown action." });
      if (r.status !== 200) return json({ ok: false, error: vrcError(r) });
      userCache.delete(id);
      if (action === "unfriend" || action === "accept") { vrcUserAt = 0; setTimeout(fullSync, 1500); }
      bump(); return json({ ok: true });
    });
    // ---------- your own profile ----------
    if (p === "/api/vrc/profile" && req.method === "GET") return vrc("auth/user").then((r) => {
      if (r.status !== 200 || !r.body?.id) return json({ error: vrcError(r) });
      vrcUser = r.body; vrcUserAt = Date.now(); const u = r.body, tags: string[] = u.tags || [];
      return json({ id: u.id, name: u.displayName, bio: u.bio || "", links: u.bioLinks || [], pronouns: u.pronouns || "", status: u.status || "active", statusText: u.statusDescription || "",
        pic: u.profilePicOverrideThumbnail || u.profilePicOverride || u.currentAvatarThumbnailImageUrl || "", icon: u.userIcon || "", banner: u.bannerUrl || "",
        vrcPlus: tags.includes("system_supporter"), languages: tags.filter((t) => t.startsWith("language_")).map((t) => t.slice(9)), history: u.statusHistory || [] });
    });
    if (p === "/api/vrc/profile" && req.method === "POST") return req.json().then(async (b: any) => {
      const body: any = {};
      if (b.bio !== undefined) body.bio = String(b.bio).slice(0, 512);
      if (b.pronouns !== undefined) body.pronouns = String(b.pronouns).slice(0, 32);
      if (b.statusText !== undefined) body.statusDescription = String(b.statusText).slice(0, 32);
      if (b.status !== undefined) { if (!["join me", "active", "ask me", "busy"].includes(b.status)) return json({ ok: false, error: "Pick a status." }); body.status = b.status; }
      if (b.links !== undefined) {
        const links = (Array.isArray(b.links) ? b.links : []).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 3);
        if (links.some((l: string) => !/^https?:\/\/\S+$/i.test(l) || l.length > 512)) return json({ ok: false, error: "Links need to start with https://" });
        body.bioLinks = links;
      }
      if (b.icon !== undefined) {
        if (b.icon && !/^https:\/\/api\.vrchat\.cloud\/api\/1\/file\/file_[0-9a-f-]{36}\/\d+(\/file)?$/.test(b.icon)) return json({ ok: false, error: "Bad picture." });
        body.userIcon = b.icon || "";
      }
      if (!Object.keys(body).length) return json({ ok: true });
      const r = await vrc(`users/${ME}`, { method: "PUT", body: JSON.stringify(body) });
      if (r.status !== 200) return json({ ok: false, error: vrcError(r) });
      vrcUser = { ...(vrcUser || {}), ...r.body }; vrcUserAt = Date.now(); userCache.delete(ME); bump();
      return json({ ok: true });
    });
    if (p === "/api/vrc/icons") return vrc("files?tag=icon&n=100").then((r) => json(Array.isArray(r.body) ? r.body.map((f: any) => {
      const v = f.versions?.[f.versions.length - 1]; return v?.file?.url ? { id: f.id, url: `https://api.vrchat.cloud/api/1/file/${f.id}/${v.version}` } : null;
    }).filter(Boolean).reverse() : { error: vrcError(r) }));
    if (p === "/api/vrc/icon" && req.method === "POST") return req.formData().then(async (fd) => {
      const file = fd.get("file") as unknown as Blob | null;
      if (!file) return json({ ok: false, error: "No image." });
      if (file.size > 10_000_000) return json({ ok: false, error: "That image is over 10 MB." });
      const out = new FormData(); out.append("tag", "icon");
      out.append("file", new Blob([await file.arrayBuffer()], { type: "image/png" }), "blob");
      const r = await vrc("file/image", { method: "POST", body: out as any });
      if (r.status !== 200) return json({ ok: false, error: vrcError(r) });
      const v = r.body?.versions?.[r.body.versions.length - 1]?.version ?? 1;
      return json({ ok: true, url: `https://api.vrchat.cloud/api/1/file/${r.body.id}/${v}` });
    });
    // ---------- avatars ----------
    if (p === "/api/vrc/avatars/favorites") return vrc("avatars/favorites?n=100").then((r) => json(Array.isArray(r.body) ? r.body.map((a: any) => ({ id: a.id, name: a.name, author: a.authorName, authorId: a.authorId, thumb: a.thumbnailImageUrl, image: a.imageUrl, status: a.releaseStatus,
      favId: a.favoriteId, group: a.favoriteGroup, current: a.id === vrcUser?.currentAvatar, platforms: [...new Set((a.unityPackages || []).map((u: any) => u.platform))] })) : { error: vrcError(r) }));
    if (p === "/api/vrc/avatars/fav" && req.method === "POST") return req.json().then(async ({ id, on, favId }: any) => {
      if (!/^avtr_[0-9a-f-]{36}$/.test(id || "")) return json({ ok: false, error: "Bad avatar." });
      const r = on ? await vrc("favorites", { method: "POST", body: JSON.stringify({ type: "avatar", favoriteId: id, tags: ["avatars1"] }) })
        : await vrc(`favorites/${/^fvrt_/.test(favId || "") ? favId : id}`, { method: "DELETE" });
      avInfoCache.clear();
      return json(r.status === 200 ? { ok: true } : { ok: false, error: vrcError(r) });
    });
    if (p === "/api/avatars/worn") return json(worlds().avatars);
    // ---------- invites, status, notes, avatars, startup ----------
    if (p === "/api/vrc/invite" && req.method === "POST") return req.json().then(async ({ userId, slot }: any) => {
      const loc = myLocation();
      if (!loc) return json({ ok: false, error: "You need to be in a world in VRChat to invite someone." });
      const r = await vrc(`invite/${userId}`, { method: "POST", body: JSON.stringify(slot >= 0 && slot <= 11 ? { instanceId: loc, messageSlot: +slot } : { instanceId: loc }) });
      return json(r.status === 200 ? { ok: true } : { ok: false, error: vrcError(r) });
    });
    if (p === "/api/chat" && req.method === "GET") { const id = s.get("id") || ""; if (!/^usr_[0-9a-f-]{36}$/.test(id)) return json({ error: "bad id" }, 400); return json({ max: MSG_MAX, thread: chatThread(id) }); }
    if (p === "/api/chat/slots") return msgSlots().then((r: any) => json(r.error ? r : { free: r.free, total: r.slots.length, nextFree: r.nextFree, sent: r.slots.map((m: any) => m.message).filter(Boolean) }));
    if (p === "/api/chat" && req.method === "POST") return req.json().then(({ id, text }: any) => sendChat(id, text)).then(json);
    if (p === "/api/vrc/requestInvite" && req.method === "POST") return req.json().then(async ({ userId, slot }: any) => {
      const r = await vrc(`requestInvite/${userId}`, { method: "POST", body: JSON.stringify(slot >= 0 && slot <= 11 ? { requestSlot: +slot } : {}) });
      return json(r.status === 200 ? { ok: true } : { ok: false, error: vrcError(r) });
    });
    if (p === "/api/vrc/selfInvite" && req.method === "POST") return req.json().then(async ({ location }: any) => {
      if (!/^wrld_[0-9a-f-]{36}:/.test(location || "")) return json({ ok: false, error: "That world can't be joined." });
      const r = await vrc(`invite/myself/to/${location}`, { method: "POST", body: "{}" });
      return json(r.status === 200 ? { ok: true } : { ok: false, error: vrcError(r) });
    });
    if (p === "/api/vrc/status" && req.method === "POST") return req.json().then(async ({ status, statusDescription }: any) => {
      if (!["join me", "active", "ask me", "busy"].includes(status)) return json({ ok: false, error: "Pick a status." });
      const r = await vrc(`users/${ME}`, { method: "PUT", body: JSON.stringify({ status, statusDescription: String(statusDescription || "").slice(0, 32) }) });
      if (r.status === 200) { vrcUser = { ...(vrcUser || {}), ...r.body }; vrcUserAt = Date.now(); }
      return json(r.status === 200 ? { ok: true } : { ok: false, error: vrcError(r) });
    });
    if (p === "/api/note" && req.method === "POST") return req.json().then(async ({ userId, note }: any) => {
      if (!/^usr_[0-9a-f-]{36}$/.test(userId || "")) return json({ ok: false }, 400);
      note = String(note || "").slice(0, 256);
      const name = fstate.get(userId)?.name || friends().find((f) => f.id === userId)?.name || "";
      sdb.query("INSERT INTO notes(user_id, display_name, note, created_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET note = excluded.note, created_at = excluded.created_at").run(userId, name, note, iso());
      bump();
      let synced = false;
      if (session.auth) { const r = await vrc("userNotes", { method: "POST", body: JSON.stringify({ targetUserId: userId, note }) }).catch(() => null); synced = r?.status === 200; }
      return json({ ok: true, synced });
    });
    if (p === "/api/vrc/avatars") return vrc("avatars?user=me&releaseStatus=all&n=100&sort=updated&order=descending").then((r) =>
      json(Array.isArray(r.body) ? r.body.map((a: any) => ({ id: a.id, name: a.name, thumb: a.thumbnailImageUrl, image: a.imageUrl, status: a.releaseStatus, updated: a.updated_at, current: a.id === vrcUser?.currentAvatar,
        platforms: [...new Set((a.unityPackages || []).map((u: any) => u.platform))] })) : { error: vrcError(r) }));
    if (p === "/api/vrc/avatar/select" && req.method === "POST") return req.json().then(async ({ id }: any) => {
      if (!/^avtr_[0-9a-f-]{36}$/.test(id || "")) return json({ ok: false, error: "Bad avatar." });
      const r = await vrc(`avatars/${id}/select`, { method: "PUT" });
      if (r.status === 200) { vrcUser = { ...(vrcUser || {}), ...r.body }; recordOwnAvatar(id); }
      return json(r.status === 200 ? { ok: true } : { ok: false, error: vrcError(r) });
    });
    if (p === "/api/startup" && req.method === "GET") return json({ supported: process.platform === "win32", on: startupOn() });
    if (p === "/api/startup" && req.method === "POST") return req.json().then(({ on }: any) => json({ ok: setStartup(!!on), on: startupOn() }));
    // ---------- where you are / worlds / groups / photos / mutuals / backup ----------
    if (p === "/api/where") { const w: any = whereAmI(); if (w.inWorld && !w.world && session.auth) worldDetails(w.worldId).catch(() => {}); return json(w); }
    if (p === "/api/vrc/messages") { const t = ["message", "request", "response", "requestResponse"].includes(s.get("type") || "") ? s.get("type") : "message";
      return vrc(`message/${ME}/${t}`).then((r) => json(Array.isArray(r.body) ? r.body.map((m: any) => ({ slot: m.slot, message: m.message })).sort((a: any, b: any) => a.slot - b.slot) : [])); }
    if (p === "/api/vrc/worlds/search") {
      const qq = (s.get("q") || "").trim(), sort = qq ? "relevance" : "popularity";
      return vrc(`worlds?n=40&sort=${sort}&order=descending${qq ? `&search=${encodeURIComponent(qq)}` : "&featured=true"}`).then((r) => json(Array.isArray(r.body) ? r.body.map(mapWorld) : { error: vrcError(r) }));
    }
    if (p === "/api/vrc/world") { const id = s.get("id") || ""; if (!/^wrld_[0-9a-f-]{36}$/.test(id)) return json({ error: "bad id" }, 400); return worldDetails(id).then(json); }
    if (p === "/api/vrc/instance") {
      const loc = s.get("loc") || ""; if (!/^wrld_[0-9a-f-]{36}:/.test(loc)) return json({ error: "bad location" }, 400);
      return vrc(`instances/${loc}`).then((r) => json(r.status === 200 ? { users: r.body.n_users ?? r.body.userCount ?? 0, capacity: r.body.capacity, type: r.body.type, region: r.body.region, full: r.body.full, queue: r.body.queueSize || 0,
        friends: friends().filter((f) => f.online && f.location === loc).map((f) => ({ id: f.id, name: f.name })), name: r.body.world?.name || worldName(loc.split(":")[0]), closed: !!r.body.closedAt } : { error: vrcError(r) }));
    }
    if (p === "/api/vrc/instance/create" && req.method === "POST") return req.json().then(async ({ worldId, type, region, invite }: any) => {
      if (!/^wrld_[0-9a-f-]{36}$/.test(worldId || "")) return json({ ok: false, error: "Pick a world." });
      const map: any = { public: { type: "public" }, "friends+": { type: "hidden" }, friends: { type: "friends" }, "invite+": { type: "private", canRequestInvite: true }, invite: { type: "private" } };
      const body: any = { worldId, region: ["us", "use", "eu", "jp"].includes(region) ? region : "us", ...(map[type] || map["friends+"]) };
      if (body.type !== "public") body.ownerId = ME;
      const r = await vrc("instances", { method: "POST", body: JSON.stringify(body) });
      if (r.status !== 200) return json({ ok: false, error: vrcError(r) });
      const loc = r.body.location || `${worldId}:${r.body.instanceId || r.body.id}`;
      if (invite) await vrc(`invite/myself/to/${loc}`, { method: "POST", body: "{}" });
      return json({ ok: true, location: loc });
    });
    if (p === "/api/worldfav" && req.method === "GET") return json(sdb.query("SELECT world_id AS id, name, thumb, author, created_at AS at FROM fav_worlds ORDER BY created_at DESC").all());
    if (p === "/api/worldfav" && req.method === "POST") return req.json().then(({ id, name, thumb, author, on }: any) => {
      if (!/^wrld_[0-9a-f-]{36}$/.test(id || "")) return json({ ok: false }, 400);
      if (on) sdb.query("INSERT OR REPLACE INTO fav_worlds(world_id, name, thumb, author, created_at) VALUES(?,?,?,?,?)").run(id, name || "", thumb || "", author || "", iso()); else sdb.query("DELETE FROM fav_worlds WHERE world_id = ?").run(id);
      return json({ ok: true });
    });
    if (p === "/api/vrc/groups") return Promise.all([vrc(`users/${ME}/groups`), vrc(`users/${ME}/instances/groups`)]).then(([g, i]) => json({
      groups: Array.isArray(g.body) ? g.body.map((x: any) => ({ id: x.groupId || x.id, name: x.name, code: x.shortCode && `${x.shortCode}.${x.discriminator}`, icon: x.iconUrl, banner: x.bannerUrl, members: x.memberCount, online: x.onlineMemberCount, representing: !!x.isRepresenting })) : [],
      instances: Array.isArray(i.body?.instances) ? i.body.instances.map((x: any) => ({ location: x.location, world: x.world?.name, thumb: x.world?.thumbnailImageUrl, users: x.memberCount ?? x.n_users ?? x.userCount, capacity: x.world?.capacity, groupId: x.ownerId || x.group?.id, groupName: x.group?.name })) : [],
      error: g.status !== 200 ? vrcError(g) : null }));
    if (p === "/api/vrc/group/announcement") { const id = s.get("id") || ""; if (!/^grp_[0-9a-f-]{36}$/.test(id)) return json({}, 400);
      return vrc(`groups/${id}/announcement`).then((r) => json(r.status === 200 && r.body?.id ? { title: r.body.title, text: r.body.text, image: r.body.imageUrl, at: r.body.createdAt } : {})); }
    if (p === "/api/photos") { const all = listPhotos(), off = +(s.get("offset") || 0); return json({ total: all.length, dirs: [...photoDirs].filter((d) => existsSync(d)), photos: all.slice(off, off + 60).map((x) => ({ id: Buffer.from(x.path).toString("base64url"), at: iso(photoTimeFromName(x.path, x.at)), name: basename(x.path) })) }); }
    if (p === "/api/photo/info") { const path = Buffer.from(s.get("id") || "", "base64url").toString(); if (!photoAllowed(path)) return json({}, 404); return json(photoInfo(path, statSync(path).mtimeMs)); }
    if (p.startsWith("/photo/")) { const path = Buffer.from(p.slice(7), "base64url").toString(); if (!photoAllowed(path) || !existsSync(path)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(path), { headers: { "cache-control": "max-age=86400" } }); }
    if (p === "/api/vrc/mutuals") { const id = s.get("id") || ""; if (!/^usr_[0-9a-f-]{36}$/.test(id)) return json([], 400);
      return vrc(`users/${id}/mutuals/friends?n=100`).then((r) => json(Array.isArray(r.body) ? r.body.map((u: any) => ({ id: u.id, name: u.displayName, thumb: u.profilePicOverrideThumbnail || u.userIcon || u.currentAvatarThumbnailImageUrl })) : [])); }
    if (p === "/api/backup") { sdb.exec("PRAGMA wal_checkpoint(TRUNCATE)"); return new Response(sdb.serialize(), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="soul-backup-${iso().slice(0, 10)}.sqlite3"` } }); }
    if (p === "/api/export") {
      const what = s.get("what") || "feed";
      const rows = what === "friendlog" ? friendLog() : what === "visits" ? worlds().visits : what === "people" ? [...meetAgg().values()] : what === "notifications" ? notifications()
        : feed({ kinds: Object.keys(FEEDS), limit: 100000 });
      return new Response(toCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="soul-${what}-${iso().slice(0, 10)}.csv"` } });
    }
    // ---------- updates ----------
    if (p === "/api/update" && req.method === "GET") { if (s.get("check")) return checkUpdate().then(() => json({ current: VERSION, ...upd, asset: !!upd.asset })); return json({ current: VERSION, ...upd, asset: !!upd.asset }); }
    if (p === "/api/update" && req.method === "POST") { installUpdate(); return json({ ok: true }); }
    // ---------- phone view ----------
    if (p === "/api/phone" && req.method === "GET") { const c = phoneCfg(); const u = phoneUrl(); return (u ? QRCode.toString(u, { type: "svg", margin: 1, color: { dark: "#111111", light: "#ffffff" } }) : Promise.resolve("")).then((qr: string) => json({ enabled: c.enabled, url: u, qr, ip: lanIp(), error: phoneErr })); }
    if (p === "/api/phone" && req.method === "POST") return req.json().then(({ enabled, reset }: any) => {
      const c = phoneCfg();
      if (reset) { c.key = randomBytes(18).toString("base64url"); }
      if (enabled !== undefined) c.enabled = !!enabled;
      setScfg("phone", JSON.stringify(c)); if (reset && phoneServer) { try { phoneServer.stop(true); } catch {} phoneServer = null; }
      startPhone(); return json({ ok: true });
    });
    if (p === "/manifest.json") return json({ name: "Soul", short_name: "Soul", start_url: "/", display: "standalone", background_color: "#0d0c16", theme_color: "#0d0c16", icons: [{ src: "/icon-256.png", sizes: "256x256", type: "image/png" }] });
    if (p === "/icon-256.png") return new Response(Bun.file(icon256), { headers: { "content-type": "image/png", "cache-control": "max-age=604800" } });
    // ---------- VR ----------
    if (p === "/api/vr" && req.method === "GET") return json({ settings: vrCfg(), steamvr, overlay: !!overlayProc, overlayError: overlayExit, windows: process.platform === "win32" });
    if (p === "/api/vr" && req.method === "POST") return req.json().then((v: any) => { const c = { ...vrCfg(), ...v }; setScfg("vr", JSON.stringify(c)); setTimeout(checkSteamVR, 100); return json({ ok: true, settings: c }); });
    if (p === "/api/overlay/cfg") return json(vrCfg());
    if (p === "/api/overlay/frame" && req.method === "POST") {
      const which = req.headers.get("x-which") === "hud" ? "hud" : "wrist", w = +(req.headers.get("x-w") || 0), h = +(req.headers.get("x-h") || 0), show = +(req.headers.get("x-show-ms") || 0);
      return req.arrayBuffer().then((b) => { if (w > 0 && h > 0 && w <= 2048 && h <= 2048 && b.byteLength === w * h * 4) frames[which] = { buf: new Uint8Array(b), w, h, ver: ++frameVer, until: show ? Date.now() + show : 0 }; return json({ ok: true }); });
    }
    if (p === "/api/overlay/frame") {
      const f = frames[s.get("which") === "hud" ? "hud" : "wrist"];
      if (!f) return new Response(null, { status: 204 });
      if (f.ver <= +(s.get("since") ?? -1)) return new Response(null, { status: 304 });
      return new Response(f.buf, { headers: { "x-w": String(f.w), "x-h": String(f.h), "x-ver": String(f.ver), "x-until": String(f.until) } });
    }
    if (p === "/api/vr/test" && req.method === "POST") { vrAlert({ title: "Soul VR alerts are working 👻", body: "This is what alerts look like in VR." }); pushAlert({ kind: "test", title: "Soul VR alerts are working 👻", body: "This is what alerts look like in VR.", img: "" }); return json({ ok: true }); }
    if (p === "/api/alerts" && req.method === "GET") return json({ settings: alertCfg(), recent: recentAlerts });
    if (p === "/api/alerts" && req.method === "POST") return req.json().then((v: any) => { const c = { ...alertCfg(), ...v }; setScfg("alerts", JSON.stringify(c)); return json({ ok: true, settings: c }); });
    if (p === "/api/alerts/test" && req.method === "POST") { pushAlert({ kind: "test", title: "Soul alerts are working 👻", body: "This is what an alert looks like.", img: "" }); return json({ ok: true }); }
    if (p === "/api/theme" && req.method === "GET") return json(readTheme());
    if (p === "/api/theme" && req.method === "POST") {
      return req.text().then((t) => { JSON.parse(t); writeFileSync(THEME_FILE, t); return json({ ok: true }); });
    }
    if (p === "/api/backgrounds") return json(readdirSync(BG_DIR).filter((f) => MIME[extname(f).toLowerCase()]).map((f) => "/bg/" + encodeURIComponent(f)));
    if (p === "/api/bg" && req.method === "POST") {
      const name = basename(decodeURIComponent(req.headers.get("x-filename") || "bg.png")).replace(/[^\w.\- ]/g, "_");
      if (!MIME[extname(name).toLowerCase()]) return json({ error: "Use a png, jpg, gif, webp, avif, mp4 or webm file." }, 400);
      return req.arrayBuffer().then((buf) => {
        if (buf.byteLength > 200 * 1024 * 1024) return json({ error: "That file is over 200 MB." }, 400);
        const fname = Date.now() + "-" + name;
        writeFileSync(join(BG_DIR, fname), new Uint8Array(buf));
        return json({ url: "/bg/" + encodeURIComponent(fname) });
      });
    }
    if (p.startsWith("/bg/")) {
      const f = join(BG_DIR, basename(decodeURIComponent(p.slice(4))));
      if (!existsSync(f)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(f), { headers: { "content-type": MIME[extname(f).toLowerCase()] || "application/octet-stream", "cache-control": "max-age=31536000" } });
    }
    if (p === "/api/quit" && req.method === "POST") { setTimeout(() => process.exit(0), 150); return json({ ok: true }); }
    return new Response("not found", { status: 404 });
  } catch (e: any) {
    logErr(e);
    return json({ error: String(e?.message || e) }, 500);
  }
}

function openWindow(url: string) {
  if (NO_OPEN) return;
  if (process.platform === "win32") {
    // Edge "app mode" gives a clean window with no tabs or address bar; falls back to the default browser.
    try {
      const prof = join(DATA_DIR, "window");
      const r = Bun.spawnSync(["cmd", "/c", "start", "", "msedge", `--app=${url}`, "--window-size=1400,900", `--user-data-dir=${prof}`,
        "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows", "--disable-features=msSleepingTabs,IntensiveWakeUpThrottling"], { windowsHide: true } as any);
      if (r.exitCode === 0) return;
    } catch {}
    Bun.spawn(["cmd", "/c", "start", "", url], { windowsHide: true } as any);
  } else {
    try { Bun.spawn(["xdg-open", url]); } catch {}
  }
}

const BASE_PORT = +(process.env.SOUL_PORT || 7317);
async function main() {
  // already running? just open the window
  try {
    const r = await fetch(`http://127.0.0.1:${BASE_PORT}/api/ping`, { signal: AbortSignal.timeout(800) });
    const info = await r.json();
    if (info.app === "soul" || info.app === "lumen") {
      if (info.app === "soul" && info.version === VERSION) { openWindow(`http://127.0.0.1:${BASE_PORT}/`); process.exit(0); }
      // an older Soul (or Lumen) is still running: ask it to quit so this newer version takes over
      await fetch(`http://127.0.0.1:${BASE_PORT}/api/quit`, { method: "POST" }).catch(() => {});
      for (let i = 0; i < 30; i++) {
        await Bun.sleep(150);
        try { await fetch(`http://127.0.0.1:${BASE_PORT}/api/ping`, { signal: AbortSignal.timeout(300) }); } catch { break; }
      }
    }
  } catch {}
  for (let port = BASE_PORT; port < BASE_PORT + 20; port++) {
    try {
      SERVER = Bun.serve({ port, hostname: "127.0.0.1", fetch: handle as any, websocket: { ...presence, idleTimeout: 0 } as any, idleTimeout: 60, maxRequestBodySize: 210 * 1024 * 1024 });
      const url = `http://127.0.0.1:${port}/`;
      PORT = port;
      console.log(`Soul ${VERSION} running at ${url}`);
      console.log(`Soul data: ${SOUL_DB_PATH}${VSRC ? ` + VRCX (read-only): ${DB_PATH}` : ""}`);
      startRecorder();
      startPhone();
      console.log(`Closing the Soul window quits Soul; minimizing keeps it running.`);
      openWindow(url);
      return;
    } catch {}
  }
  console.error("Couldn't find a free port.");
}
main();
