"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV: { href: string; label: string }[] = [
  { href: "/docs", label: "Getting Started" },
  { href: "/docs/staking-basics", label: "Staking Basics" },
  { href: "/docs/create-a-label", label: "Create a Label" },
  { href: "/docs/architecture", label: "Architecture" },
  { href: "/docs/validator-selection", label: "Validator Selection" },
  { href: "/docs/glossary", label: "Glossary" },
  { href: "/docs/faq", label: "FAQ & Known Issues" },
];

export function DocsSidebar() {
  const pathname = usePathname();
  return (
    <nav className="w-56 shrink-0 space-y-1 text-sm">
      {NAV.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`block rounded-lg px-3 py-2 transition ${
              active
                ? "bg-zinc-800 text-zinc-100 font-medium"
                : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
