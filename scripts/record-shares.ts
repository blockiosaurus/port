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
  await card("Tokenize your PORT", "Turn one account into a million fungible shares, and back.<br/><span style='font-size:19px;color:#8a8373'>PORT update · mpl-hybrid (MPL-404)</span>");
  await hold(5);
  await uncard();

  // A funded, delegated PORT (same path as the main demo, compressed) while the problem is stated.
  await caption("An account is all-or-nothing", "A PORT is one asset. You can sell the whole thing or nothing: nobody can own a piece of it, a piece has no price, and the only buyer is someone who wants all of it.");
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
  await caption("A managed account worth $2,500", "Wallet A owns it. The Asset Signer holds USDC and ANTHROPIC. An agent runs the mandate under a revocable delegation. Now make it divisible.");
  await hold(7);

  // Why: fractional ownership with a hard redemption floor
  await page.getByRole("heading", { name: "Shares" }).scrollIntoViewIfNeeded();
  await caption("Fractional ownership, built in", "Every PORT ships with an mpl-hybrid escrow holding 1,000,000 shares. Shares are plain SPL tokens: send them, sell them, pool them, post them as collateral. The full supply always redeems the account, so one share is anchored to one millionth of NAV.");
  await hold(20);

  // Tokenize
  await caption("One swap turns the account into shares", "No wrapper contract, no new program: mpl-hybrid releaseV1 moves the PORT into escrow and the full supply out to the owner.");
  await hold(6);
  await btn("Tokenize").click();
  await waitFor(text(/PORT locked in its hybrid escrow/));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await caption("A program holds it, not a custodian", "The escrow is a PDA with sealed terms: it cannot change the fee, lower the redemption price or hand the account to anyone who doesn't bring every share. Nobody can touch the mandate while the account is split.");
  await hold(15);

  // Why: a fund unit, not a frozen asset
  await caption("A fund share, not a frozen asset", "The agent's delegation survived the move into escrow. It keeps planning rebalances and running every policy check for the shareholders, so they own a managed account, not a snapshot of one.");
  await btn("Run agent").scrollIntoViewIfNeeded();
  await btn("Run agent").click();
  await waitFor(text(/Agent executed \d trade/), 300_000);
  await hold(12);
  await page.getByRole("button", { name: "Close" }).click();

  // Why: liquidity
  await page.getByRole("heading", { name: "Shares" }).scrollIntoViewIfNeeded();
  await caption("Liquidity", "Shares move like any token: to a wallet, a DEX pool, a lending market. Price discovery happens on the shares, not on an illiquid whole. Here, all of them go to Wallet B.");
  await hold(12);
  await btn(/Send shares/).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send shares", exact: true }).click();
  await waitFor(text(/Sent 1,000,000 shares/));
  await hold(2);

  // Redeem: whole again
  await caption("Whole again when someone wants it whole", "Whoever gathers the full supply can redeem: Wallet B pays the shares back into escrow and takes the account out intact.");
  await page.getByRole("tablist", { name: "Acting wallet" }).getByRole("tab").nth(1).click(); // Wallet B
  await hold(2);
  await btn("Faucet").click();
  await hold(3);
  await btn("Redeem PORT").click({ timeout: 60_000 });
  await waitFor(text(/Shares paid back into escrow/));
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await caption("Fungible when split, one asset when whole", "Same Asset Signer, same positions, same mandate, same agent. The escrow holds the supply again, so the account can be split as many times as its owners want. That is what MPL-404 is for.");
  await hold(15);

  await caption("");
  await card("One account. A million owners, or one.", "PORT shares, built on mpl-hybrid.<br/><span style='font-size:18px;color:#8a8373'>ownport.xyz · Metaplex Core Execute · MPL Agent · mpl-hybrid</span>");
  await hold(6);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
