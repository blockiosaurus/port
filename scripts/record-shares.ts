/**
 * Records the short feature video for PORT shares (mpl-hybrid): a funded, delegated PORT is
 * tokenized, the owner is locked out while the agent keeps running, the shares move to another
 * wallet, and that wallet redeems the account.
 *
 *   pnpm demo:reset && pnpm dev:fork        (in another terminal)
 *   pnpm demo:record:shares                 → docs/demo/port-shares.mp4
 */
import { APP, record } from "./lib/recorder";

record("shares", "docs/demo/port-shares.mp4", async ({ page, caption, card, uncard, hold, waitFor, btn, text }) => {
  await page.goto(APP);
  await page.waitForLoadState("networkidle");
  await card("Tokenize your PORT", "An update: every PORT now carries an mpl-hybrid (MPL-404) share escrow.<br/><span style='font-size:19px;color:#8a8373'>Lock the whole account for 1,000,000 shares. Collect every share to take it back.</span>");
  await hold(5);
  await uncard();

  // A funded, delegated PORT (same path as the main demo, compressed).
  await caption("Set up a PORT", "Wallet A mints a PORT, deposits 2,500 USDC into the Asset Signer, buys $700 of ANTHROPIC through Core Execute and delegates execution to the agent.");
  await btn("Faucet").click();
  await hold(3);
  await btn("Create PORT").click();
  await waitFor(text("Net asset value"));
  await page.getByRole("button", { name: "Deposit", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Deposit", exact: true }).click();
  await waitFor(text(/Deposited 2,500 USDC into the Asset Signer/));
  await btn("Trade").first().click();
  await page.getByRole("dialog").getByRole("combobox").nth(1).selectOption("ANTHROPIC");
  await page.getByRole("dialog").getByRole("textbox").fill("700");
  await btn("Review trade").click();
  await waitFor(btn(/Sign & execute 1/));
  await btn(/Sign & execute 1/).click();
  await waitFor(text(/buy ANTHROPIC confirmed through Core Execute/));
  await btn("Delegate execution to agent").click();
  await waitFor(text(/Agent executive may now Execute/));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await caption("A funded PORT", "Vermilion = Wallet A, the <b>Core owner</b>. The verdigris <b>Asset Signer</b> holds the positions. The ochre <b>agent</b> may Execute under a revocable delegation.");
  await hold(7);

  // The share escrow
  await page.getByRole("heading", { name: "Shares" }).scrollIntoViewIfNeeded();
  await caption("Every PORT ships with a share escrow", "Minted into its own one-asset collection with an mpl-hybrid escrow that already holds 1,000,000 shares. The collection authority was handed to the System Program: the terms can never change.");
  await hold(12);

  // Tokenize
  await caption("Tokenize", "One releaseV1 swap: the PORT goes into escrow, the full supply comes out to the owner.");
  await hold(4);
  await btn("Tokenize").click();
  await waitFor(text(/PORT locked in its hybrid escrow/));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await caption("The escrow owns the deed", "Violet = the <b>Hybrid escrow</b>, now the Core owner. Wallet A holds 1,000,000 shares. Owner actions are disabled: Core rejects anyone but the owner, and the escrow signs nothing but the swap back.");
  await hold(10);

  // The agent still runs
  await caption("The agent keeps running", "The delegation survived the transfer into escrow. Run it: it plans the rebalance for the shareholders and runs every policy check; trades execute through delegated Core Execute only when all of them pass. Nobody can change the mandate it follows.");
  await btn("Run agent").scrollIntoViewIfNeeded();
  await btn("Run agent").click();
  await waitFor(text(/Agent executed \d trade/), 300_000);
  await hold(9);
  await page.getByRole("button", { name: "Close" }).click();

  // Shares move
  await page.getByRole("heading", { name: "Shares" }).scrollIntoViewIfNeeded();
  await caption("Shares are plain SPL tokens", "Wallet A sends all 1,000,000 shares to Wallet B. Any share count below the full supply carries no rights.");
  await hold(5);
  await btn(/Send shares/).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send shares", exact: true }).click();
  await waitFor(text(/Sent 1,000,000 shares/));
  await hold(2);

  // Redeem
  await caption("Wallet B redeems", "Holding every share, Wallet B pays them back into escrow with one captureV1 swap and takes the whole account out.");
  await page.getByRole("tablist", { name: "Acting wallet" }).getByRole("tab").nth(1).click(); // Wallet B
  await hold(2);
  await btn("Faucet").click();
  await hold(3);
  await btn("Redeem PORT").click({ timeout: 60_000 });
  await waitFor(text(/Shares paid back into escrow/));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await caption("Same account, new owner", "Wallet B is the Core owner. Same Asset Signer, same positions, same mandate, same agent delegation. The escrow holds the supply again, ready for the next tokenize.");
  await hold(10);
  await page.getByRole("heading", { name: "Activity" }).scrollIntoViewIfNeeded();
  await caption("Verified on-chain", "Tokenize and redeem are recorded only after the transaction confirmed, was signed by the claimed actor and touched the PORT.");
  await hold(6);

  await caption("");
  await card("Collect every share, own the account.", "PORT shares, built on mpl-hybrid.<br/><span style='font-size:18px;color:#8a8373'>ownport.xyz · Metaplex Core Execute · MPL Agent · mpl-hybrid</span>");
  await hold(6);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
