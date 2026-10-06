/**
 * Shared harness for the demo videos: drives the real UI (fork mode) in headless Chrome with
 * Playwright, burns captions and title cards into the page, marks waits on the network/chain so
 * the cut can fast-forward them, and exports each caption's final-cut time for the narration.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { chromium, type Locator, type Page } from "playwright";

export const APP = process.env.APP_URL ?? "http://localhost:3100";
const W = 1440, H = 900;

type Mark = { from: number; to: number };

export type Recorder = {
  page: Page;
  caption: (title: string, body?: string) => Promise<void>;
  card: (title: string, body: string) => Promise<void>;
  uncard: () => Promise<void>;
  hold: (seconds: number) => Promise<void>;
  /** A wait on the network/chain: recorded so the edit can fast-forward it. */
  waitFor: (loc: Locator, timeout?: number) => Promise<void>;
  btn: (name: string | RegExp) => Locator;
  text: (t: string | RegExp) => Locator;
};

/** Records `run` to `${out}.mp4`; raw video, waits and caption anchors land in `.demo/video/<name>/`. */
export async function record(name: string, out: string, run: (r: Recorder) => Promise<void>) {
  const RAW = `.demo/video/${name}`;
  const waits: Mark[] = [];
  const marks: Array<{ title: string; raw: number }> = [];
  await rm(RAW, { recursive: true, force: true });
  await mkdir(RAW, { recursive: true });
  await mkdir(out.replace(/\/[^/]+$/, ""), { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: RAW, size: { width: W, height: H } }, colorScheme: "light" });
  await context.addInitScript(() => {
    (window as any).__caption = (title: string, body = "") => {
      let el = document.getElementById("__cap");
      if (!el) {
        el = document.createElement("div");
        el.id = "__cap";
        el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;max-width:980px;width:calc(100% - 64px);background:rgba(27,26,23,.92);color:#f3eee3;border-radius:14px;padding:14px 22px;font:500 17px/1.45 'Schibsted Grotesk',system-ui,sans-serif;box-shadow:0 18px 40px -18px rgba(0,0,0,.6);transition:opacity .25s";
        document.documentElement.appendChild(el);
      }
      el.style.opacity = title ? "1" : "0";
      el.innerHTML = title ? `<div style="font:italic 400 26px/1.1 'Instrument Serif',serif;color:#fb9a6b;margin-bottom:4px">${title}</div>${body}` : "";
    };
    (window as any).__card = (title: string, body: string) => {
      const c = document.createElement("div");
      c.id = "__card";
      c.style.cssText = "position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f3eee3;color:#1b1a17;text-align:center;padding:48px";
      c.innerHTML = `<div style="font:400 104px/0.95 'Instrument Serif',serif;letter-spacing:-1px">${title}</div><div style="margin-top:22px;max-width:900px;font:400 24px/1.5 'Schibsted Grotesk',system-ui,sans-serif;color:#4a463d">${body}</div>`;
      document.documentElement.appendChild(c);
    };
    (window as any).__uncard = () => document.getElementById("__card")?.remove();
  });
  const page = await context.newPage();
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;

  const r: Recorder = {
    page,
    caption: (title, body = "") => {
      if (title) marks.push({ title, raw: now() });
      return page.evaluate(([t, b]) => (window as any).__caption(t, b), [title, body]);
    },
    card: (title, body) => {
      marks.push({ title, raw: now() });
      return page.evaluate(([t, b]) => (window as any).__card(t, b), [title, body]);
    },
    uncard: () => page.evaluate(() => (window as any).__uncard()),
    hold: (s) => page.waitForTimeout(s * 1000),
    waitFor: async (loc, timeout = 180_000) => {
      const from = now();
      await loc.first().waitFor({ state: "visible", timeout });
      waits.push({ from: from + 0.6, to: Math.max(from + 0.6, now() - 0.4) });
    },
    btn: (name) => page.getByRole("button", { name }),
    text: (t) => page.getByText(t),
  };

  await run(r);

  const video = page.video();
  await context.close();
  await browser.close();
  const raw = video ? await video.path() : (await readdir(RAW)).map((f) => `${RAW}/${f}`)[0]!;
  await writeFile(`${RAW}/waits.json`, JSON.stringify(waits, null, 2));
  const toCut = cut(raw, out, waits);
  await writeFile(`${RAW}/captions.json`, JSON.stringify(marks.map((m) => ({ title: m.title, at: Number(toCut(m.raw).toFixed(2)) })), null, 2));
}

/**
 * Keep everything at 1×, fast-forward recorded waits at 8× (label stays visible in the caption).
 * Returns a raw-time → cut-time mapping so caption anchors can be exported for the narration.
 */
function cut(input: string, output: string, fast: Mark[]): (raw: number) => number {
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input]).toString().trim());
  const segs: Array<{ a: number; b: number; speed: number }> = [];
  let cursor = 0;
  for (const w of fast.filter((w) => w.to - w.from > 1.5).sort((x, y) => x.from - y.from)) {
    if (w.from > cursor) segs.push({ a: cursor, b: w.from, speed: 1 });
    segs.push({ a: w.from, b: w.to, speed: 8 });
    cursor = w.to;
  }
  if (cursor < dur) segs.push({ a: cursor, b: dur, speed: 1 });
  const parts = segs.map((s, i) => `[0:v]trim=start=${s.a.toFixed(3)}:end=${s.b.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed}[v${i}]`);
  const filter = `${parts.join(";")};${segs.map((_, i) => `[v${i}]`).join("")}concat=n=${segs.length}:v=1:a=0,fps=30,format=yuv420p[out]`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", input, "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", output], { stdio: "inherit" });
  const final = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output]).toString().trim());
  console.log(`raw ${dur.toFixed(0)}s → ${output} ${final.toFixed(0)}s (${fast.length} waits fast-forwarded)`);
  return (raw: number) => {
    let t = 0;
    for (const s of segs) {
      if (raw >= s.b) t += (s.b - s.a) / s.speed;
      else {
        if (raw > s.a) t += (raw - s.a) / s.speed;
        break;
      }
    }
    return t;
  };
}
