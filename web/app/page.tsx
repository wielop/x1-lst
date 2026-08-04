"use client";

import { useState } from "react";
import { MinesGame } from "@/components/MinesGame";
import { WykopGame } from "@/components/WykopGame";

export default function Home() {
  const [tab, setTab] = useState<"mines" | "wykop">("mines");

  return (
    <div>
      <div className="tab-switcher">
        <button className={tab === "mines" ? "active" : ""} onClick={() => setTab("mines")}>
          Mines
        </button>
        <button className={tab === "wykop" ? "active" : ""} onClick={() => setTab("wykop")}>
          Wykop
        </button>
      </div>
      {tab === "mines" ? <MinesGame /> : <WykopGame />}
    </div>
  );
}
