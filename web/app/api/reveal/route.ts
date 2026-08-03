import { NextRequest, NextResponse } from "next/server";

// Server-only — deliberately not NEXT_PUBLIC_, so the resolver's address
// never ships in the client bundle. This route exists purely to dodge
// mixed-content blocking: the page is served over HTTPS (Vercel), the
// resolver is plain HTTP on a VPS with no domain/cert of its own, and
// browsers refuse to let an HTTPS page call HTTP directly. Proxying through
// a same-origin API route sidesteps that — the browser only ever talks to
// x1-lst.vercel.app over HTTPS; this server-side fetch to the resolver
// isn't subject to the browser's mixed-content policy at all.
const RESOLVER_URL = process.env.RESOLVER_URL ?? "http://localhost:8787";

export async function POST(req: NextRequest) {
  const body = await req.text();
  try {
    const res = await fetch(`${RESOLVER_URL}/reveal`, {
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
