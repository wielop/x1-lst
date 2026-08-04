import { NextRequest, NextResponse } from "next/server";

// Same-origin HTTPS proxy to the resolver, same reasoning as api/reveal —
// see that route's comment.
const RESOLVER_URL = process.env.RESOLVER_URL ?? "http://localhost:8787";

export async function POST(req: NextRequest) {
  const body = await req.text();
  try {
    const res = await fetch(`${RESOLVER_URL}/dig-reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const data = await res.text();
    return new NextResponse(data, { status: res.status, headers: { "Content-Type": "application/json" } });
  } catch (err: any) {
    return NextResponse.json({ error: `resolver unreachable: ${err.message ?? err}` }, { status: 502 });
  }
}
