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

type Cue = { at: number; text: string };
const CUES: Cue[] = [
  { at: 0.9, text: "PORT. An investment account you can own." },
  { at: 5.8, text: "A PORT is a Core asset on a mainnet fork. Its Asset Signer holds the stocks; only Core Execute can trade them." },
  { at: 12.8, text: "Fund a burner wallet from the faucet." },
  { at: 15.9, text: "Mint the PORT." },
  { at: 18.3, text: "The mandate lives on the asset; update authority is renounced. Vermilion is the owner. The verdigris seal is the Asset Signer." },
  { at: 26.3, text: "Deposit USDC into an account only Core Execute can move." },
  { at: 31.1, text: "Now buy OpenAI." },
  { at: 34.4, text: "The server quotes a live Jupiter route and runs every policy check: Pyth freshness, spread, deviation, issuer fee, slippage, cash floor. All pass." },
  { at: 44.3, text: "The swap ran inside Core Execute. The Asset Signer holds the position, not the wallet." },
  { at: 51.3, text: "Delegate to the agent." },
  { at: 53.6, text: "It computes drift, plans the smallest rebalance, checks every trade, and executes through delegated Core Execute." },
  { at: 62.4, text: "Each trade shows its rationale and every check. In thin pre-IPO books, the agent halves a trade when market impact is the only failing check." },
  { at: 77.9, text: "Every price that permits or blocks a trade is shown, with its age, confidence and band." },
  { at: 85.0, text: "The agent's token trades on a Meteora bonding curve quoted in tokenized NVIDIA. Fees accrue in stock; it is not a claim on the PORT." },
  { at: 94.7, text: "The finale: Wallet A sells the whole PORT to Wallet B with one Core transfer." },
  { at: 103.1, text: "Conveyed. The owner changed. The Asset Signer, every balance, and the mandate are identical. The delegation carried over and is flagged for review." },
  { at: 116.2, text: "Wallet B now owns it: same Asset Signer, same positions, and a warning to review the inherited delegate." },
  { at: 126.3, text: "The new owner sells Anduril through Core Execute, with the same checks." },
  { at: 136.3, text: "Then revokes the inherited agent." },
  { at: 140.2, text: "The full history travels with the account, every action verified on chain." },
  { at: 147.4, text: "The stocks never moved. Ownership did." },
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
    body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, speed: 1.12 } }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  const videoLen = probe(INPUT);
  const clips: Array<{ file: string; start: number; len: number; cue: Cue; drift: number }> = [];
  let cursor = 0;
  for (const cue of CUES) {
    const file = await speak(cue.text);
    const len = probe(file);
    const start = Math.max(cue.at, cursor);
    clips.push({ file, start, len, cue, drift: start - cue.at });
    cursor = start + len + GAP;
  }
  for (const c of clips) console.log(`${c.cue.at.toFixed(1).padStart(6)}s  ${c.len.toFixed(1).padStart(5)}s  drift ${c.drift >= 1 ? "+" + c.drift.toFixed(1) + "s" : "   ok"}  ${c.cue.text.slice(0, 60)}`);
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
