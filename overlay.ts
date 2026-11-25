// Soul's SteamVR overlay helper. Runs as a separate process ("Soul.exe --overlay") so that if
// SteamVR closes or misbehaves, the main Soul app keeps running and keeps recording.
// It talks to SteamVR through Valve's openvr_api.dll (bundled) and pulls the pictures to show
// from the main Soul process, which draws them.
import { dlopen, FFIType, ptr, read, CFunction } from "bun:ffi";
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import dllEmbedded from "./openvr_api.dll" with { type: "file" };

const cstr = (s: string) => Buffer.from(s + "\0", "utf8");

// System.Numerics-style matrix helpers (row vectors), converted to OpenVR's 3x4 layout
type M4 = number[][];
const mul = (a: M4, b: M4): M4 => a.map((r) => [0, 1, 2, 3].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j] + r[3] * b[3][j]));
const scale = (s: number): M4 => [[s, 0, 0, 0], [0, s, 0, 0], [0, 0, s, 0], [0, 0, 0, 1]];
const rx = (t: number): M4 => [[1, 0, 0, 0], [0, Math.cos(t), Math.sin(t), 0], [0, -Math.sin(t), Math.cos(t), 0], [0, 0, 0, 1]];
const ry = (t: number): M4 => [[Math.cos(t), 0, -Math.sin(t), 0], [0, 1, 0, 0], [Math.sin(t), 0, Math.cos(t), 0], [0, 0, 0, 1]];
const rz = (t: number): M4 => [[Math.cos(t), Math.sin(t), 0, 0], [-Math.sin(t), Math.cos(t), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const tr = (x: number, y: number, z: number): M4 => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [x, y, z, 1]];
function hmd34(m: M4) {
  const f = new Float32Array(12);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) f[r * 4 + c] = m[c][r];
  return f;
}
const D = Math.PI / 180;
const WRIST = {
  left: hmd34(mul(mul(mul(mul(scale(0.25), rx(90 * D)), ry(90 * D)), rz(-90 * D)), tr(-0.07, -0.05, 0.06))),
  right: hmd34(mul(mul(mul(mul(scale(0.25), rx(-90 * D)), ry(-90 * D)), rz(-90 * D)), tr(0.07, -0.05, 0.06))),
};
const HUD = hmd34(tr(0, -0.3, -1.5));

export async function runOverlayChild(port: number, dataDir: string) {
  const log = (m: any) => { try { writeFileSync(join(dataDir, "soul-overlay.log"), `[${new Date().toISOString()}] ${m?.stack || m}\n`, { flag: "a" }); } catch {} };
  try {
    // put the DLL somewhere real on disk (it's embedded in Soul.exe)
    const dir = join(dataDir, "openvr"); mkdirSync(dir, { recursive: true });
    const dllPath = join(dir, "openvr_api.dll");
    const src = Bun.file(dllEmbedded);
    if (!existsSync(dllPath) || statSync(dllPath).size !== src.size) writeFileSync(dllPath, new Uint8Array(await src.arrayBuffer()));

    const lib = dlopen(dllPath, {
      VR_InitInternal2: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.u32 },
      VR_GetGenericInterface: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      VR_ShutdownInternal: { args: [], returns: FFIType.void },
      VR_IsHmdPresent: { args: [], returns: FFIType.bool },
    });
    const err = new Int32Array(1);
    lib.symbols.VR_InitInternal2(ptr(err), 2 /* VRApplication_Overlay */, null);
    if (err[0] !== 0) { log("SteamVR init failed, error " + err[0]); process.exit(2); }
    const iface = (name: string) => { const p = lib.symbols.VR_GetGenericInterface(ptr(cstr("FnTable:" + name)), ptr(err)); if (!p || err[0]) throw new Error(`no ${name} (${err[0]})`); return p; };
    const sysT = iface("IVRSystem_026"), ovT = iface("IVROverlay_028");
    const fn = (table: any, idx: number, args: any[], returns: any) => CFunction({ ptr: read.ptr(table, idx * 8) as any, args, returns });
    const V = FFIType;
    const sys = {
      roleIndex: fn(sysT, 18, [V.i32], V.u32),
      poll: fn(sysT, 30, [V.ptr, V.u32], V.bool),
      ackQuit: fn(sysT, 47, [], V.void),
    };
    const ov = {
      create: fn(ovT, 1, [V.ptr, V.ptr, V.ptr], V.i32),
      destroy: fn(ovT, 3, [V.u64], V.i32),
      alpha: fn(ovT, 16, [V.u64, V.f32], V.i32),
      sort: fn(ovT, 20, [V.u64, V.u32], V.i32),
      width: fn(ovT, 22, [V.u64, V.f32], V.i32),
      relative: fn(ovT, 35, [V.u64, V.u32, V.ptr], V.i32),
      show: fn(ovT, 43, [V.u64], V.i32),
      hide: fn(ovT, 44, [V.u64], V.i32),
      raw: fn(ovT, 62, [V.u64, V.ptr, V.u32, V.u32, V.u32], V.i32),
    };
    const make = (key: string, name: string) => {
      const h = new BigUint64Array(1);
      const e = ov.create(ptr(cstr(key)), ptr(cstr(name)), ptr(h));
      if (e !== 0) throw new Error(`CreateOverlay ${key} failed: ${e}`);
      return h[0];
    };
    const wrist = make("soul.wrist." + process.pid, "Soul — friends");
    const hud = make("soul.hud." + process.pid, "Soul — alerts");
    ov.width(wrist, 1); ov.width(hud, 1); ov.sort(hud, 10);
    const state: any = { wrist: { ver: -1, shown: false }, hud: { ver: -1, shown: false }, hand: "left", wristOn: true, hudOn: true };
    const base = `http://127.0.0.1:${port}`;
    const ev = new Uint8Array(64);
    let quit = false;
    const shutdown = () => { if (quit) return; quit = true; try { ov.destroy(wrist); ov.destroy(hud); } catch {} try { lib.symbols.VR_ShutdownInternal(); } catch {} process.exit(0); };
    process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
    log("overlay started");

    let tick = 0;
    while (!quit) {
      // SteamVR events: leave cleanly when SteamVR quits
      while (sys.poll(ptr(ev), 64)) { const type = new DataView(ev.buffer).getUint32(0, true); if (type === 700) { try { sys.ackQuit(); } catch {} shutdown(); } }
      try {
        if (tick % 10 === 0) {
          const c = await fetch(`${base}/api/overlay/cfg`).then((r) => r.json());
          if (!c.enabled) shutdown();
          state.hand = c.hand === "right" ? "right" : "left"; state.wristOn = !!c.wrist; state.hudOn = !!c.hud;
        }
        for (const which of ["wrist", "hud"] as const) {
          const r = await fetch(`${base}/api/overlay/frame?which=${which}&since=${state[which].ver}`);
          const h = which === "wrist" ? wrist : hud;
          const on = which === "wrist" ? state.wristOn : state.hudOn;
          if (r.status === 200) {
            const w = +r.headers.get("x-w")!, hh = +r.headers.get("x-h")!;
            const buf = new Uint8Array(await r.arrayBuffer());
            if (buf.length === w * hh * 4) ov.raw(h, ptr(buf), w, hh, 4);
            state[which].ver = +r.headers.get("x-ver")!;
            state[which].until = +r.headers.get("x-until")! || 0;
          } else if (r.status === 304) { /* unchanged */ }
          const visible = on && (which === "wrist" ? true : Date.now() < (state.hud.until || 0)) && state[which].ver >= 0;
          if (which === "wrist") {
            const dev = sys.roleIndex(state.hand === "right" ? 2 : 1);
            if (dev !== 0xffffffff) ov.relative(h, dev, ptr(WRIST[state.hand as "left" | "right"]));
          } else ov.relative(h, 0, ptr(HUD));
          if (visible && !state[which].shown) { ov.show(h); state[which].shown = true; }
          if (!visible && state[which].shown) { ov.hide(h); state[which].shown = false; }
        }
      } catch (e: any) {
        // main Soul went away -> close too
        if (String(e?.message || e).includes("Unable to connect") || String(e).includes("ECONNREFUSED")) shutdown();
        log(e);
      }
      tick++;
      await Bun.sleep(250);
    }
  } catch (e) { log(e); process.exit(1); }
}
