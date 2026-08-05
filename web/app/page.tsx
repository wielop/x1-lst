"use client";

import { useState } from "react";
import { MinesGame } from "@/components/MinesGame";
import { WykopGame } from "@/components/WykopGame";
import { StakingPanel } from "@/components/StakingPanel";

export default function Home() {
  const [tab, setTab] = useState<"mines" | "wykop" | "staking">("mines");

  return (
    <div>
      <div className="tab-switcher">
        <button className={tab === "mines" ? "active" : ""} onClick={() => setTab("mines")}>
          Mines
        </button>
        <button className={tab === "wykop" ? "active" : ""} onClick={() => setTab("wykop")}>
          Wykop
        </button>
        <button className={tab === "staking" ? "active" : ""} onClick={() => setTab("staking")}>
          Stake
        </button>
      </div>
      {tab === "mines" ? <MinesGame /> : tab === "wykop" ? <WykopGame /> : null}
      {/* Kept mounted (just hidden) rather than unmounted like the other two
       * tabs: StakingPanel derives its "recent accrual rate" / Estimated
       * APY from acc_reward_per_weight samples gathered live over its own
       * lifetime (see the accSamples comment in StakingPanel.tsx) — needs
       * ~20s of real polling before it has enough spread to show a number.
       * Unmounting it every time the player tabs away to go play Mines or
       * Wykop reset that window to zero on every return, so APY/rate never
       * had a chance to fill in — it looked permanently stuck on
       * "gathering rate data...". Hidden-but-mounted lets it keep sampling
       * in the background the whole session. */}
      <div style={{ display: tab === "staking" ? "block" : "none" }}>
        <StakingPanel />
      </div>
    </div>
  );
}
