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
      {tab === "mines" ? <MinesGame /> : tab === "wykop" ? <WykopGame /> : <StakingPanel />}
    </div>
  );
}
