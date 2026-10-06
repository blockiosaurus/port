/**
 * Adds a synthesized voice-over to the recorded demo. The captions burned into
 * docs/demo/port-demo.mp4 are the script; each cue below is spoken at the moment its caption
 * appears. Cue times come from .demo/video/captions.json, written by record-demo.ts in final-cut
 * seconds (an `after` anchor names the caption; `at` is an explicit override). Audio is generated
 * once per line with ElevenLabs and cached, then mixed under the existing video with ffmpeg.
 * The picture is not re-encoded.
 *
 *   ELEVENLABS_API_KEY=… pnpm demo:narrate        → docs/demo/port-demo-narrated.mp4
 *
 * Clips are placed at their cue time, or right after the previous clip if that one is still
 * playing; the script reports how far each line drifts from its caption so lines can be trimmed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

/** Which video: "main" (docs/demo/port-demo.mp4) or "shares" (docs/demo/port-shares.mp4). */
const DEMO = (process.env.DEMO ?? "main") as "main" | "shares";
const BASE = DEMO === "main" ? "docs/demo/port-demo" : "docs/demo/port-shares";
const INPUT = process.env.DEMO_INPUT ?? `${BASE}.mp4`;
const OUTPUT = process.env.DEMO_OUTPUT ?? `${BASE}-narrated.mp4`; // rename over the input once approved
const CACHE = ".demo/narration";
const VOICE = process.env.ELEVENLABS_VOICE_ID ?? "jTm8RvtbGj4ihx7YyqdV"; // "Christopher - Narrator & Host"
const MODEL = "eleven_multilingual_v2";
const GAP = 0.35; // seconds between consecutive clips when the previous one overruns

/** `after` anchors a line to the caption with that title; `at` is seconds; lines with neither follow the previous line. */
type Cue = { at?: number; after?: string; text: string };
const MAIN_CUES: Cue[] = [
  { after: "PORT", text: "This is PORT. An investment account you can actually own." },
  { after: "The thesis", text: "A brokerage account bundles custody, positions and automation, and the broker owns all of it. PORT makes that bundle one object on Solana: a Metaplex Core asset. This runs on a fork of mainnet: real programs, real PreStocks pools, no real money." },
  { text: "The verdigris seal is the Asset Signer, a program-derived account that holds every position. The mandate lives on the asset itself, and an escrow already holds a million shares of it. The owner deposits USDC that only Core Execute can move." },
  { after: "Buy Anthropic PreStocks", text: "Now a trade: buy Anthropic. Before anything is signed, the server quotes a live Jupiter route and runs every policy check. The owner signs, the swap runs inside Core Execute, and the position lands in the Asset Signer, not the wallet." },
  { after: "Delegate to the agent", text: "Trading by hand is only half of it. The owner can delegate execution to an agent: a registered MPL Agent executive whose key stays on the server. The agent reads positions and prices, computes drift, and plans the smallest rebalance back to target. Every trade goes through the same checks, and it signs through delegated Core Execute. When market impact is the only thing failing, it halves the trade instead of forcing it." },
  { after: "Prices that permit or block", text: "Every price that permits or blocks a trade is on screen, with its age and confidence. The agent also has its own market: a Meteora bonding curve quoted in tokenized NVIDIA, so its fees accrue in stock. That token is not a claim on the account." },
  { after: "The finale: transfer the account", text: "Here is the point of all this. The owner sells the entire account to Wallet B with a single Core transfer." },
  { after: "Conveyed", text: "Look at what changed and what didn't. The owner changed. The Asset Signer, every balance and the mandate are identical. Nothing moved. The agent delegation carried over too, and the new owner is told to review it." },
  { after: "Wallet B is now the owner", text: "Wallet B connects and is in control immediately: same account, same positions, same rules." },
  { after: "The new owner trades", text: "It sells some Anthropic through Core Execute, then revokes the inherited agent. From here, the agent's next execute is rejected on chain." },
  { after: "Tokenize the account", text: "One more way to own it. Wallet B tokenizes the account: one mpl-hybrid swap locks the PORT in escrow and pays out a million shares." },
  { after: "The escrow owns the deed", text: "The escrow owns the deed now. Nobody can trade by hand, change the mandate or delegate, but a live agent delegation keeps running. Only the full supply can take the account back." },
  { after: "Shares are plain SPL tokens", text: "The shares are ordinary tokens. Wallet B sends all of them to Wallet A." },
  { after: "Wallet A redeems", text: "Holding every share, Wallet A pays them back into escrow and takes the whole account out. Same Asset Signer, same positions, same mandate." },
  { after: "The full history travels with the account", text: "And the full history travels with it: every action, signer and policy result, verified on chain." },
  { after: "The stocks never moved.", text: "The stocks never moved. Ownership did. That's PORT." },
];

const SHARES_CUES: Cue[] = [
  { after: "Tokenize your PORT", text: "A PORT update. Every PORT now carries an mpl-hybrid share escrow, so the whole account can be tokenized." },
  { after: "Set up a PORT", text: "First, a funded account. Wallet A mints a PORT, deposits USDC, buys some Anthropic through Core Execute, and delegates execution to the agent." },
  { after: "A funded PORT", text: "Three identities. Wallet A is the Core owner. The Asset Signer holds the positions. The agent may execute under a revocable delegation." },
  { after: "Every PORT ships with a share escrow", text: "Here's what's new. The PORT was minted into its own collection with an mpl-hybrid escrow that already holds one million shares. The collection authority went to the System Program, so the terms can never change: no fee edits, no cheaper redemption, no backdoor." },
  { after: "Tokenize", text: "Tokenize is one swap. The PORT goes into escrow and the full supply comes out to the owner." },
  { after: "The escrow owns the deed", text: "The escrow is the Core owner now, and Wallet A holds a million shares. Owner actions are disabled; the escrow can sign nothing except the swap back." },
  { after: "The agent keeps running", text: "But the agent's delegation survived. Run it, and it plans the rebalance for the shareholders and runs every policy check. Trades go through only when all of them pass, under a mandate nobody can change." },
  { after: "Shares are plain SPL tokens", text: "The shares are ordinary SPL tokens. Wallet A sends all of them to Wallet B; anything short of the full supply carries no rights." },
  { after: "Wallet B redeems", text: "Holding every share, Wallet B pays them back into escrow and takes the whole account out." },
  { after: "Same account, new owner", text: "Same Asset Signer, same positions, same mandate, same agent. Only the owner changed, and the escrow holds the supply again, ready for the next tokenize." },
  { after: "Verified on-chain", text: "Both swaps are in the history, recorded only after they confirmed on chain." },
  { after: "Collect every share, own the account.", text: "Collect every share, own the account. PORT shares, built on mpl-hybrid." },
];
const CUES = DEMO === "main" ? MAIN_CUES : SHARES_CUES;

const CAPTIONS = `.demo/video/${DEMO}/captions.json`;
function anchorOf(cue: Cue): number | undefined {
  if (cue.at !== undefined) return cue.at;
  if (!cue.after) return undefined;
  const marks: Array<{ title: string; at: number }> = JSON.parse(readFileSync(CAPTIONS, "utf8"));
  const m = marks.find((x) => x.title === cue.after);
  if (!m) throw new Error(`No caption titled "${cue.after}" in ${CAPTIONS}`);
  return m.at;
}

const probe = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());

async function speak(text: string): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const file = `${CACHE}/${createHash("sha1").update(`${VOICE}|${MODEL}|${text}`).digest("hex").slice(0, 12)}.mp3`;
  if (existsSync(file)) return file;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, speed: 1.1 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/**
 * Generated clips end with a breath or a soft hitch, audible because every line here is followed
 * by silence. Trim what trails the last word (below -38 dB) and fade the last 180 ms out.
 */
function tidy(file: string): string {
  const out = file.replace(/\.mp3$/, ".wav");
  if (existsSync(out)) return out;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-af", "areverse,silenceremove=start_periods=1:start_silence=0.12:start_threshold=-38dB,areverse,afade=t=in:d=0.04", out]);
  const len = probe(out);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", out, "-af", `afade=t=out:st=${Math.max(0, len - 0.18).toFixed(3)}:d=0.18`, `${out}.tmp.wav`]);
  execFileSync("mv", [`${out}.tmp.wav`, out]);
  return out;
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  const videoLen = probe(INPUT);
  const clips: Array<{ file: string; start: number; len: number; cue: Cue; drift: number }> = [];
  let cursor = 0;
  for (const cue of CUES) {
    const file = tidy(await speak(cue.text));
    const len = probe(file);
    const at = anchorOf(cue);
    const start = Math.max(at ?? 0, cursor);
    clips.push({ file, start, len, cue, drift: at === undefined ? 0 : start - at });
    cursor = start + len + GAP;
  }
  for (const c of clips) console.log(`${(c.cue.at ?? c.start).toFixed(1).padStart(6)}s  ${c.len.toFixed(1).padStart(5)}s  drift ${c.drift >= 1 ? "+" + c.drift.toFixed(1) + "s" : "   ok"}  ${c.cue.text.slice(0, 60)}`);
  const end = cursor - GAP;
  if (end > videoLen) console.warn(`⚠ narration ends at ${end.toFixed(1)}s, video is ${videoLen.toFixed(1)}s: trim the last lines`);

  const inputs = clips.flatMap((c) => ["-i", c.file]);
  const delayed = clips.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.start * 1000)}|${Math.round(c.start * 1000)}[a${i}]`).join(";");
  const mix = `${clips.map((_, i) => `[a${i}]`).join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad,atrim=0:${videoLen.toFixed(3)}[out]`;
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", INPUT, ...inputs, "-filter_complex", `${delayed};${mix}`, "-map", "0:v", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", OUTPUT], { stdio: "inherit" });
  console.log(`\n${OUTPUT}  ${probe(OUTPUT).toFixed(1)}s, ${clips.length} lines, ${CUES.reduce((n, c) => n + c.text.length, 0)} characters`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
