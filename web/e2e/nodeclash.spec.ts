import { test, expect, type Page } from "@playwright/test";

/** Plays through mulligan (no exchange) so the test lands on the match screen. */
async function skipMulligan(page: Page) {
  await page.getByRole("button", { name: "Potwierdź" }).click();
}

/** Passes Orders/Combat every time it's the human's turn until the match ends (result screen
 * visible) or a safety cap is hit — used for "finish a full match" without needing specific
 * card knowledge. */
async function playUntilMatchEnds(page: Page, maxClicks = 30) {
  for (let i = 0; i < maxClicks; i++) {
    if (await page.getByText(/Wygrywasz!|Przegrywasz|Remis!/).isVisible().catch(() => false)) return;
    const endOrders = page.getByRole("button", { name: "Zakończ Fazę Rozkazów" });
    const endCombat = page.getByRole("button", { name: "Zakończ atakowanie" });
    if (await endOrders.isVisible().catch(() => false)) {
      await endOrders.click();
    } else if (await endCombat.isVisible().catch(() => false)) {
      await endCombat.click();
    } else {
      await page.waitForTimeout(150);
    }
  }
}

test.describe("Node Clash MVP", () => {
  test("1. home page opens and shows all main navigation cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Node Clash" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Samouczek/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Zagraj z botem/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Kolekcja/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Kreator talii/ })).toBeVisible();
    // No NFT/marketplace/wallet links should be offered as active features at this stage
    // (the footer's own "bez NFT" scope disclaimer is expected and fine — that's not a feature).
    await expect(page.getByRole("link", { name: /NFT|marketplace|portfel|wallet/i })).toHaveCount(0);
  });

  test("2. tutorial starts and shows the first interactive step", async ({ page }) => {
    await page.goto("/tutorial");
    await expect(page.getByRole("heading", { name: "Samouczek" })).toBeVisible();
    await page.getByRole("button", { name: "Dalej" }).click();
    await expect(page.getByText(/To jest Twoja ręka/)).toBeVisible();
  });

  test("3. tutorial can be completed end to end", async ({ page }) => {
    await page.goto("/tutorial");
    await page.getByRole("button", { name: "Dalej" }).click(); // intro -> hand
    await page.getByRole("button", { name: "Dalej" }).click(); // hand -> select

    // Select the (only, homogeneous) card in hand.
    await page.locator("button[aria-label^='Rig Rookie']").first().click();
    await expect(page.getByText(/Zagraj tutaj/).first()).toBeVisible();
    await page.getByRole("button", { name: "Zagraj tutaj" }).first().click();
    await expect(page.getByText(/Widzisz liczby przy węźle/)).toBeVisible();
    await page.getByRole("button", { name: "Dalej" }).click(); // control -> endOrders

    // The lone 1-cost card may exhaust the human's Gas immediately, auto-cascading straight
    // past Orders into (or through) Combat — click whichever phase-end button is present.
    const endOrders = page.getByRole("button", { name: "Zakończ Fazę Rozkazów" });
    const endCombat = page.getByRole("button", { name: "Zakończ atakowanie" });
    if (await endOrders.isVisible({ timeout: 5000 }).catch(() => false)) {
      await endOrders.click();
    } else if (await endCombat.isVisible({ timeout: 2000 }).catch(() => false)) {
      await endCombat.click();
    }
    await expect(page.getByText(/atakować/)).toBeVisible({ timeout: 10_000 });

    // From here the exact board state is not scripted (both sides trade 1-cost vanilla units
    // round over round), so drive the rest opportunistically and robustly: attack with our own
    // unit if one is available, otherwise just pass through phases, until either the wrap-up
    // step or the tutorial's own GAME_OVER safeguard (jumps straight to wrap-up) is reached.
    const wrapupText = page.getByText(/Kliknij „Zakończ samouczek”/);
    const skipLink = page.getByText("Przejdź dalej");
    for (let i = 0; i < 25 && !(await wrapupText.isVisible().catch(() => false)); i++) {
      if (await skipLink.isVisible().catch(() => false)) {
        await skipLink.click();
        break;
      }
      const ownAttacker = page.locator("button:not([disabled])", { hasText: "Rig Rookie" }).first();
      const endOrdersBtn = page.getByRole("button", { name: "Zakończ Fazę Rozkazów" });
      const endCombatBtn = page.getByRole("button", { name: "Zakończ atakowanie" });
      if (await ownAttacker.isVisible().catch(() => false)) {
        await ownAttacker.click();
        const enemyTarget = page.locator("button:not([disabled])", { hasText: "Shitcoin Shiller" }).first();
        if (await enemyTarget.isVisible({ timeout: 1500 }).catch(() => false)) {
          await enemyTarget.click();
          continue;
        }
      }
      if (await endCombatBtn.isVisible().catch(() => false)) {
        await endCombatBtn.click();
      } else if (await endOrdersBtn.isVisible().catch(() => false)) {
        await endOrdersBtn.click();
      } else {
        await page.waitForTimeout(150);
      }
    }
    await expect(wrapupText).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Zakończ samouczek" }).click();
    await expect(page.getByRole("heading", { name: "Ukończono!" })).toBeVisible();
  });

  test("4-5-6. deck selection, starting a bot match, and a legal move", async ({ page }) => {
    await page.goto("/play?seed=1&botFaction=DEGENS");
    await expect(page.getByRole("heading", { name: "Zagraj z botem" })).toBeVisible();
    await expect(page.getByText("Rig Starter")).toBeVisible(); // MINERS is selected by default
    await page.getByRole("button", { name: "Normalny" }).click();
    await page.getByRole("button", { name: "Rozpocznij mecz" }).click();

    await expect(page.getByRole("heading", { name: "Mulligan" })).toBeVisible();
    await skipMulligan(page);

    await expect(page.getByText(/Runda 1\/6/)).toBeVisible();
    // With seed=1, P0's opening hand includes Hash Apprentice (cost 1, legal at Gas=1).
    await page.locator("button[aria-label^='Hash Apprentice']").first().click();
    await page.getByRole("button", { name: "Zagraj tutaj" }).first().click();
    // A unit chip for it should now appear somewhere on the board.
    await expect(page.getByTitle(/Hash Apprentice/).first()).toBeVisible();
  });

  test("7. an illegal move (too expensive for current Gas) is rejected with a specific reason", async ({ page }) => {
    await page.goto("/play?seed=1&botFaction=DEGENS");
    await page.getByRole("button", { name: "Rozpocznij mecz" }).click();
    await skipMulligan(page);
    // With seed=1, Overclocked Rig / Mining Pool cost 3 — illegal at round-1 Gas=1.
    await page.locator("button[aria-label^='Overclocked Rig'], button[aria-label^='Mining Pool']").first().click();
    await expect(page.getByText(/Za mało energii/)).toBeVisible();
  });

  test("8-9. finishing a full match reaches the result screen, and rematch starts a new one", async ({ page }) => {
    await page.goto("/play?seed=7&botFaction=VALIDATORS");
    await page.getByRole("button", { name: "Łatwy" }).click();
    await page.getByRole("button", { name: "Rozpocznij mecz" }).click();
    await skipMulligan(page);
    await playUntilMatchEnds(page);
    await expect(page.getByText(/Wygrywasz!|Przegrywasz|Remis!/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Rund: \d/)).toBeVisible();

    await page.getByRole("button", { name: "Rewanż" }).click();
    await expect(page.getByRole("heading", { name: "Mulligan" })).toBeVisible();
  });

  test("10. collection page opens and lists all 60 cards, filterable by faction", async ({ page }) => {
    await page.goto("/collection");
    await expect(page.getByText("Kolekcja (60 kart)")).toBeVisible();
    await page.getByRole("combobox").first().selectOption("BUILDERS");
    await expect(page.getByText(/12 kart pasuje/)).toBeVisible();
  });

  test("11-12-13. build a deck, save it, and use it to start a match", async ({ page }) => {
    await page.goto("/deck-builder");
    await expect(page.getByRole("heading", { name: "Kreator talii" })).toBeVisible();

    // Faction defaults to MINERS; add 2 copies of every non-legendary Miners+Neutral card
    // available until the deck is exactly 20, using the pool "+" buttons in order.
    const plusButtons = page.locator("button[aria-label^='Dodaj']");
    let size = 0;
    let guard = 0;
    while (size < 20 && guard++ < 200) {
      const count = await plusButtons.count();
      let clicked = false;
      for (let i = 0; i < count; i++) {
        const btn = plusButtons.nth(i);
        if (await btn.isEnabled()) {
          await btn.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) break;
      const sizeText = await page.getByText(/Karty: \d+\/20/).textContent();
      size = Number(sizeText?.match(/(\d+)\/20/)?.[1] ?? 0);
    }
    await expect(page.getByText("Talia poprawna, gotowa do gry.")).toBeVisible();

    await page.getByPlaceholder("Nazwa talii").fill("E2E Test Deck");
    await page.getByRole("button", { name: "Zapisz talię" }).click();
    await expect(page.getByText(/Zapisano talię/)).toBeVisible();
    await expect(page.getByText("E2E Test Deck", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Zagraj tą talią" }).click();
    await expect(page).toHaveURL(/\/play\?savedDeck=/);
    await expect(page.getByText("E2E Test Deck", { exact: false })).toBeVisible();
  });
});
