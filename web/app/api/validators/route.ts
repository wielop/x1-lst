import { Connection } from "@solana/web3.js";
import { NextResponse } from "next/server";
import { selectValidators, DEFAULT_SELECTION_PARAMS } from "@/lib/validatorSelection";
import { POOL_CONFIG } from "@/lib/poolConfig";

export const revalidate = 60;

export async function GET() {
  try {
    const connection = new Connection(POOL_CONFIG.rpcUrl, "confirmed");
    const { candidates, survivors } = await selectValidators(connection, DEFAULT_SELECTION_PARAMS);
    return NextResponse.json({
      params: DEFAULT_SELECTION_PARAMS,
      candidateCount: candidates.length,
      survivors,
      candidates,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
