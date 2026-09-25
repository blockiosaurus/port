/**
 * Adds a synthesized voice-over to the recorded demo. The captions burned into
 * docs/demo/port-demo.mp4 are the script; each cue below is spoken at the moment its caption
 * appears (times measured from the final cut). Audio is generated once per line with ElevenLabs
 * and cached, then mixed under the existing video with ffmpeg. The picture is not re-encoded.
 *
 *   ELEVENLABS_API_KEY=… pnpm demo:narrate        → docs/demo/port-demo-narrated.mp4
 *
 * Clips are placed at their cue time, or right after the previous clip if that one is still
 * playing; the script reports how far each line drifts from its caption so lines can be trimmed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

const INPUT = process.env.DEMO_INPUT ?? "docs/demo/port-demo.mp4";
const OUTPUT = process.env.DEMO_OUTPUT ?? "docs/demo/port-demo-narrated.mp4";
const CACHE = ".demo/narration";
const VOICE = process.env.ELEVENLABS_VOICE_ID ?? "jTm8RvtbGj4ihx7YyqdV"; // "Christopher - Narrator & Host"
const MODEL = "eleven_multilingual_v2";
const GAP = 0.35; // seconds between consecutive clips when the previous one overruns

/** `at` anchors a line to a moment in the picture; lines without it follow the previous line. */
type Cue = { at?: number; text: string };
const CUES: Cue[] = [
  { at: 0.9, text: "This is PORT. An investment account you can actually own." },
  { at: 5.8, text: "A brokerage account bundles custody, positions and automation, and the broker owns all of it. PORT makes that bundle one object on Solana: a Metaplex Core asset. This runs on a fork of mainnet: real programs, real PreStocks pools, no real money." },
  { text: "The verdigris seal is the Asset Signer, a program-derived account that holds every position. The mandate lives on the asset itself; the creator has renounced update authority. The owner deposits USDC into an account only Core Execute can move." },
  { at: 34.4, text: "Now a trade: buy OpenAI. Before anything is signed, the server quotes a live Jupiter route and runs every policy check: Pyth freshness, spread, size, cash floor. The owner signs, the swap runs inside Core Execute, and the position lands in the Asset Signer, not the wallet." },
  { at: 51.3, text: "Trading by hand is only half of it. The owner can delegate execution to an agent: a registered MPL Agent executive whose key stays on the server. The agent reads positions and prices, computes drift, and plans the smallest rebalance back to target. Every trade goes through the same checks, and it signs through delegated Core Execute. When market impact is the only thing failing, it halves the trade instead of forcing it." },
  { at: 77.9, text: "Every price that permits or blocks a trade is on screen, with its age and confidence. The agent also has its own market: a Meteora bonding curve quoted in tokenized NVIDIA, so its fees accrue in stock. That token is not a claim on the account." },
  { at: 94.7, text: "Here is the point of all this. The owner sells the entire account to Wallet B with a single Core transfer." },
  { at: 103.1, text: "Look at what changed and what didn't. The owner changed. The Asset Signer, every balance and the mandate are identical. Nothing moved. The agent delegation carried over too, and the new owner is told to review it." },
  { at: 116.2, text: "Wallet B connects and is in control immediately: same account, same positions, same rules." },
  { at: 126.3, text: "It sells some Anduril through Core Execute, then revokes the inherited agent. From here, the agent's next execute is rejected on chain." },
  { at: 140.2, text: "And the full history travels with it: every action, signer and policy result, verified on chain." },
  { at: 147.4, text: "The stocks never moved. Ownership did. That's PORT." },
];

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
    const start = Math.max(cue.at ?? 0, cursor);
    clips.push({ file, start, len, cue, drift: cue.at === undefined ? 0 : start - cue.at });
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
