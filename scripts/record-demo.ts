/**
 * Records the full demo video by driving the real UI (fork mode) in Chrome with Playwright.
 * Captions narrate each beat; waits on live quotes/confirmations are marked and later sped up
 * by ffmpeg, so the final cut stays near the 3-minute target without faking anything.
 *
 *   pnpm demo:reset && pnpm demo:agent-market && pnpm dev:fork   (in another terminal)
 *   pnpm demo:record                                             → docs/demo/port-demo.mp4
 *
 * The harness (captions, cards, fast-forwarded waits, caption anchors) is scripts/lib/recorder.ts.
 */
import { APP, record } from "./lib/recorder";

record("main", "docs/demo/port-demo.mp4", async ({ page, caption, card, uncard, hold, waitFor, btn, text }) => {
  // 1. Thesis
  await page.goto(APP);
  await page.waitForLoadState("networkidle");
  await card("PORT", "An investment account you can own.<br/><span style='font-size:19px;color:#8a8373'>A Metaplex Core asset whose Asset Signer holds a pre-IPO PreStocks portfolio · Stocklana</span>");
  await hold(5);
  await uncard();
  await caption("The thesis", "A PORT is a Core asset. Its deterministic <b>Asset Signer</b> holds the portfolio and trades only through <b>Core Execute</b>. Running on a local fork of Solana mainnet: real programs, real PreStocks pools, no real funds.");
  await hold(7);

  // 2. Create
  await caption("Fund Wallet A", "Fork faucet: SOL + USDC for a browser burner wallet (Wallet A).");
  await btn("Faucet").click();
  await hold(3);
  await caption("Mint AI Private Markets Fund #001", "One Core asset in its own sealed collection. The mandate is stored on the asset in an owner-managed plugin, an MPL Agent identity is registered, and an mpl-hybrid share escrow is funded with 1,000,000 shares.");
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
  await caption("Buy Anthropic PreStocks", "The owner asks for $700 of ANTHROPIC. Before anything is signed, the server quotes a live Jupiter route and runs every policy check against it.");
  await btn("Trade").first().click();
  await page.getByRole("dialog").getByRole("combobox").nth(1).selectOption("ANTHROPIC");
  await page.getByRole("dialog").getByRole("textbox").fill("700");
  await btn("Review trade").click();
  await waitFor(btn(/Sign & execute 1/));
  await caption("Pyth-gated risk review", "Pyth USDC/USD freshness and confidence, market spread, reference deviation, 1% issuer transfer fee, slippage, trade size, cash floor, program allowlist: all pass.");
  await hold(9);
  await btn(/Sign & execute 1/).click();
  await waitFor(text(/buy ANTHROPIC confirmed through Core Execute/));
  await caption("Signed by the Asset Signer", "The Jupiter swap into the live PreStocks pool ran inside Core Execute. The ANTHROPIC position is held by the Asset Signer, not the wallet.");
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
  await caption("The new owner trades", "Wallet B sells $50 of Anthropic through Core Execute, with the same policy checks.");
  await btn("Trade").first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("combobox").nth(0).selectOption("sell");
  await dlg.getByRole("combobox").nth(1).selectOption("ANTHROPIC");
  await dlg.getByRole("textbox").fill("50");
  await btn("Review trade").click();
  await waitFor(btn(/Sign & execute 1/));
  await hold(3);
  await btn(/Sign & execute 1/).click();
  await waitFor(text(/sell ANTHROPIC confirmed through Core Execute/));
  await hold(3);
  await caption("…and revokes the inherited agent", "Revoked on-chain. The agent's next Execute would be rejected.");
  await page.getByRole("button", { name: "Revoke" }).scrollIntoViewIfNeeded();
  await btn("Revoke").click();
  await waitFor(text(/Delegation revoked/));
  await hold(3);

  // 8. Tokenize → shares → redeem
  await page.getByRole("heading", { name: "Shares" }).scrollIntoViewIfNeeded();
  await caption("Tokenize the account", "Wallet B locks the PORT in its mpl-hybrid escrow and receives the full supply of 1,000,000 shares. The escrow terms were sealed at creation.");
  await hold(4);
  await btn("Tokenize").click();
  await waitFor(text(/PORT locked in its hybrid escrow/));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await caption("The escrow owns the deed", "Violet = the <b>Hybrid escrow</b>. Nobody can trade by hand, edit the mandate or delegate; a live agent delegation would keep running. Only every share, together, can take it back.");
  await hold(8);
  await page.getByRole("heading", { name: "Shares" }).scrollIntoViewIfNeeded();
  await caption("Shares are plain SPL tokens", "Wallet B sends all 1,000,000 shares to Wallet A.");
  await btn(/Send shares/).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send shares", exact: true }).click();
  await waitFor(text(/Sent 1,000,000 shares/));
  await hold(2);
  await caption("Wallet A redeems", "Holding the full supply, Wallet A pays it back into escrow and takes the whole account out: same Asset Signer, same positions, same mandate.");
  await page.getByRole("tablist", { name: "Acting wallet" }).getByRole("tab").first().click(); // Wallet A
  await hold(3);
  await btn("Redeem PORT").click({ timeout: 60_000 });
  await waitFor(text(/Shares paid back into escrow/));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await hold(7);
  await page.getByRole("heading", { name: "Activity" }).scrollIntoViewIfNeeded();
  await caption("The full history travels with the account", "Every action, signer, rationale and policy result, each verified on-chain before it was recorded.");
  await hold(7);

  // 9. Close
  await caption("");
  await card("The stocks never moved.", "Ownership of the programmable account did.<br/><span style='font-size:18px;color:#8a8373'>Metaplex Core Execute · MPL Agent · mpl-hybrid · PreStocks · Pyth · Meteora DBC</span>");
  await hold(6);

}).catch((e) => {
  console.error(e);
  process.exit(1);
});
