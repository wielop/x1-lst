import Link from "next/link";
import { DocsSidebar } from "@/components/DocsSidebar";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto max-w-5xl px-4 py-4 flex items-center justify-between">
          <div className="font-semibold">X1 Liquid Staking — Docs</div>
          <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-100">
            ← Back to app
          </Link>
        </div>
      </header>
      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-10 flex gap-10">
        <DocsSidebar />
        <div className="flex-1 min-w-0 docs-prose">{children}</div>
      </main>
    </div>
  );
}
