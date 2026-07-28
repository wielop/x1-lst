import Link from "next/link";

function NavCard({ href, title, desc, accent }: { href: string; title: string; desc: string; accent: string }) {
  return (
    <Link
      href={href}
      className="block rounded-xl border border-[var(--border)] p-5 transition hover:-translate-y-0.5 hover:border-white/40"
      style={{ background: "var(--bg-panel)" }}
    >
      <div className="text-lg font-bold" style={{ color: accent }}>
        {title}
      </div>
      <p className="mt-1 text-sm text-[var(--text-dim)]">{desc}</p>
    </Link>
  );
}

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-10">
      <header className="text-center">
        <h1 className="text-4xl font-extrabold tracking-tight">Node Clash</h1>
        <p className="mt-2 text-[var(--text-dim)]">
          Szybka gra karciana o kontrolę trzech Węzłów Sieci. Mecz trwa kilka minut. Wszystkie karty są darmowe.
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NavCard href="/tutorial" title="Samouczek" desc="Naucz się zasad grając prawdziwy, uproszczony mecz." accent="#4fd18a" />
        <NavCard href="/play" title="Zagraj z botem" desc="Wybierz frakcję i poziom trudności bota." accent="#e0524f" />
        <NavCard href="/collection" title="Kolekcja" desc="Przeglądaj wszystkie 60 kart Node Clash." accent="#4fa8e0" />
        <NavCard href="/deck-builder" title="Kreator talii" desc="Zbuduj i zapisz własną talię." accent="#d9a441" />
        <NavCard href="/rules" title="Zasady" desc="Krótkie, jednostronicowe podsumowanie reguł." accent="#9aa3b5" />
      </section>

      <footer className="mt-auto pt-6 text-center text-xs text-[var(--text-dim)]">
        Wersja MVP — rozgrywka off-chain, bez portfela, bez NFT. Wszystkie karty dostępne od razu.
      </footer>
    </main>
  );
}
