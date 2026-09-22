/**
 * Records the demo video by driving the real UI (fork mode) in Chrome with Playwright.
 * Captions narrate each beat; waits on live quotes/confirmations are marked and later sped up
 * by ffmpeg, so the final cut stays near the 3–4 minute target without faking anything.
 *
 *   pnpm demo:reset && pnpm demo:agent-market && pnpm dev:fork   (in another terminal)
 *   pnpm tsx scripts/record-demo.ts                              → docs/demo/port-demo.mp4
 */
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { chromium, type Locator } from "playwright";

const APP = process.env.APP_URL ?? "http://localhost:3100";
const OUT = "docs/demo";
const RAW = ".demo/video";
const W = 1440, H = 900;

type Mark = { from: number; to: number };
const waits: Mark[] = [];
let t0 = 0;
const now = () => (Date.now() - t0) / 1000;

async function main() {
  await rm(RAW, { recursive: true, force: true });
  await mkdir(RAW, { recursive: true });
  await mkdir(OUT, { recursive: true });
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
  t0 = Date.now();

  const caption = (title: string, body = "") => page.evaluate(([t, b]) => (window as any).__caption(t, b), [title, body]);
  const hold = (s: number) => page.waitForTimeout(s * 1000);
  /** A wait on the network/chain: recorded so the edit can fast-forward it. */
  const waitFor = async (loc: Locator, timeout = 180_000) => {
    const from = now();
    await loc.first().waitFor({ state: "visible", timeout });
    waits.push({ from: from + 0.6, to: Math.max(from + 0.6, now() - 0.4) });
  };
  const btn = (name: string | RegExp) => page.getByRole("button", { name });
  const text = (t: string | RegExp) => page.getByText(t);

  // 1. Thesis
  await page.goto(APP);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => (window as any).__card("PORT", "An investment account you can own.<br/><span style='font-size:19px;color:#8a8373'>A Metaplex Core asset whose Asset Signer holds a pre-IPO PreStocks portfolio · Stocklana</span>"));
  await hold(5);
  await page.evaluate(() => (window as any).__uncard());
  await caption("The thesis", "A PORT is a Core asset. Its deterministic <b>Asset Signer</b> holds the portfolio and trades only through <b>Core Execute</b>. Running on a local fork of Solana mainnet: real programs, real PreStocks pools, no real funds.");
  await hold(7);

  // 2. Create
  await caption("Fund Wallet A", "Fork faucet: SOL + USDC for a browser burner wallet (Wallet A).");
  await btn("Faucet").click();
  await hold(3);
  await caption("Mint AI Private Markets Fund #001", "One Core asset. The mandate is stored on the asset in an owner-managed plugin, an MPL Agent identity is registered, and update authority is renounced.");
  await btn("Create PORT").click();
  await waitFor(text("Net asset value"));
  await caption("The deed", "Vermilion = the <b>Core owner</b> (Wallet A). Verdigris seal = the <b>Asset Signer</b>, the PDA that will hold every position.");
  await hold(8);

  // 3. Fund and buy
  await caption("Deposit", "2,500 USDC moves into a token account owned by the Asset Signer. From here only Core Execute can move it.");
  await page.getByRole("button", { name: "Deposit", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Deposit", exact: true }).click();
  await waitFor(text(/Deposited 2,500 USDC into the Asset Signer/));
  await hold(3);
  await caption("Buy OpenAI PreStocks", "The owner asks for $700 of OPENAI. Before anything is signed, the server quotes a live Jupiter route and runs every policy check against it.");
  await btn("Trade").first().click();
  await page.getByRole("dialog").getByRole("textbox").fill("700");
  await btn("Review trade").click();
  await waitFor(btn(/Sign & execute 1/));
  await caption("Pyth-gated risk review", "Pyth USDC/USD freshness and confidence, market spread, reference deviation, 1% issuer transfer fee, slippage, trade size, cash floor, program allowlist: all pass.");
  await hold(9);
  await btn(/Sign & execute 1/).click();
  await waitFor(text(/buy OPENAI confirmed through Core Execute/));
  await caption("Signed by the Asset Signer", "The Jupiter → Manifest swap ran inside Core Execute. The OPENAI position is held by the Asset Signer, not the wallet.");
  await page.getByRole("heading", { name: "Positions" }).scrollIntoViewIfNeeded();
  await hold(7);

  // 4 + 5. Agent
  await caption("Delegate to the agent", "The owner grants execution to a registered MPL Agent executive. The agent's key never leaves the server.");
  await btn("Delegate execution to agent").click();
  await waitFor(text(/Agent executive may now Execute/));
  await hold(2);
  await caption("Run the agent", "Deterministic plan: compute drift, propose the smallest rebalance, quote each trade, run every check, then execute through <b>delegated</b> Core Execute.");
  await btn("Run agent").click();
  await waitFor(text(/Agent executed \d trade/), 300_000);
  await caption("Bounded autonomy", "Each trade shows its rationale and every policy check. In thin pre-IPO books the agent halves a trade when market impact is the only failing check: the smallest trade that still moves toward target.");
  await hold(10);
  await page.getByRole("dialog").evaluate((d) => d.scrollBy({ top: 500, behavior: "smooth" }));
  await hold(5);
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("heading", { name: /Prices & risk inputs/ }).scrollIntoViewIfNeeded();
  await caption("Prices that permit or block", "Jupiter bid/ask mid for the exact pool, Pyth USDC/USD, PreStocks mark as reference, all shown with age, confidence and band.");
  await hold(7);

  // 6. Agent market
  const market = page.getByRole("heading", { name: /Agent market/ });
  if (await market.count()) {
    await market.scrollIntoViewIfNeeded();
    await caption("The agent's market", "PORTA trades on a Meteora Dynamic Bonding Curve quoted in NVDAx (tokenized NVIDIA). Fees accrue to the operator in stock. The token is not a claim on the PORT.");
    await hold(9);
  }

  // 7. Transfer finale
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await caption("The finale: transfer the account", "Wallet A sells the whole PORT to Wallet B with one Core transfer.");
  await hold(3);
  await btn(/Transfer PORT/).click();
  await hold(4);
  await btn("Transfer ownership").click();
  await waitFor(page.getByRole("dialog", { name: "Title transferred" }), 120_000);
  await caption("Conveyed", "Owner changed. Asset Signer, every balance, the mandate: identical. The agent delegation carried over and is flagged for review.");
  await hold(11);
  await btn(/Connect as Wallet B/).click();
  await hold(2);
  await caption("Wallet B is now the owner", "Same Asset Signer, same positions. Wallet B inherits the delegate and is warned to review it.");
  await hold(6);
  await btn("Faucet").click();
  await hold(4);
  await caption("The new owner trades", "Wallet B sells $50 of Anduril through Core Execute, with the same policy checks.");
  await btn("Trade").first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("combobox").nth(0).selectOption("sell");
  await dlg.getByRole("combobox").nth(1).selectOption("ANDURIL");
  await dlg.getByRole("textbox").fill("50");
  await btn("Review trade").click();
  await waitFor(btn(/Sign & execute 1/));
  await hold(3);
  await btn(/Sign & execute 1/).click();
  await waitFor(text(/sell ANDURIL confirmed through Core Execute/));
  await hold(3);
  await caption("…and revokes the inherited agent", "Revoked on-chain. The agent's next Execute would be rejected.");
  await page.getByRole("button", { name: "Revoke" }).scrollIntoViewIfNeeded();
  await btn("Revoke").click();
  await waitFor(text(/Delegation revoked/));
  await hold(3);
  await page.getByRole("heading", { name: "Activity" }).scrollIntoViewIfNeeded();
  await caption("The full history travels with the account", "Every action, signer, rationale and policy result, each verified on-chain before it was recorded.");
  await hold(7);

  // 8. Close
  await caption("");
  await page.evaluate(() => (window as any).__card("The stocks never moved.", "Ownership of the programmable account did.<br/><span style='font-size:18px;color:#8a8373'>Metaplex Core Execute · MPL Agent · PreStocks · Pyth · Meteora DBC</span>"));
  await hold(6);

  const video = page.video();
  await context.close();
  await browser.close();
  const raw = video ? await video.path() : (await readdir(RAW)).map((f) => `${RAW}/${f}`)[0]!;
  await writeFile(`${RAW}/waits.json`, JSON.stringify(waits, null, 2));
  cut(raw, `${OUT}/port-demo.mp4`, waits);
}

/** Keep everything at 1×, fast-forward recorded waits at 8× (label stays visible in the caption). */
function cut(input: string, output: string, fast: Mark[]) {
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
