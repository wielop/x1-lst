import Link from "next/link";

export default function RulesPage() {
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-10">
      <Link href="/" className="text-sm text-[var(--text-dim)] hover:text-white">
        ← Powrót
      </Link>
      <h1 className="mt-4 text-3xl font-extrabold">Zasady w skrócie</h1>

      <div className="mt-6 space-y-5 text-sm leading-relaxed">
        <section>
          <h2 className="text-lg font-bold text-white">Cel gry</h2>
          <p className="mt-1 text-[var(--text-dim)]">
            Plansza ma <b>3 Węzły Sieci</b>. Mecz trwa dokładnie <b>6 rund</b>. Na koniec liczy się{" "}
            <b>Hashpower</b> — suma ATK Twoich żywych jednostek na każdym węźle. Kto ma wyższy Hashpower na węźle,
            ten go kontroluje. Gracz kontrolujący <b>co najmniej 2 z 3 węzłów</b> wygrywa mecz.
          </p>
        </section>
        <section>
          <h2 className="text-lg font-bold text-white">Tura</h2>
          <p className="mt-1 text-[var(--text-dim)]">
            Każda runda: obaj gracze dostają Gas (rośnie z numerem rundy), dobierają kartę, a potem na przemian
            zagrywają karty (Faza Rozkazów) i atakują (Faza Walki). Zagranie jednostki kosztuje jej bazowy koszt +
            1 Gas za każdą Twoją jednostkę już stojącą na tym węźle (Opłata Przeciążeniowa) — warto rozkładać siły.
          </p>
        </section>
        <section>
          <h2 className="text-lg font-bold text-white">Atak</h2>
          <p className="mt-1 text-[var(--text-dim)]">
            Jednostka może atakować dopiero rundę po tym, jak weszła do gry (chyba że ma <b>Rush</b>). Atakuje tylko
            wroga na TYM SAMYM węźle. Jeśli broniący przeżyje, oddaje tyle samo obrażeń z powrotem (retaliacja),
            chyba że atakujący ma <b>Ranged</b>. <b>Tarcza</b> blokuje całe jedno trafienie.
          </p>
        </section>
        <section>
          <h2 className="text-lg font-bold text-white">Węzły mają własne premie</h2>
          <ul className="mt-1 list-disc pl-5 text-[var(--text-dim)]">
            <li>
              <b>Węzeł 1 — Fast Lane:</b> wchodząca tu jednostka dostaje trwałe +1 ATK.
            </li>
            <li>
              <b>Węzeł 2 — Cold Storage:</b> wchodząca tu jednostka dostaje Tarczę.
            </li>
            <li>
              <b>Węzeł 3 — Public Mempool:</b> gdy Twoja jednostka tu zginie, dobierasz kartę.
            </li>
          </ul>
        </section>
        <section>
          <h2 className="text-lg font-bold text-white">Słowa kluczowe</h2>
          <ul className="mt-1 list-disc pl-5 text-[var(--text-dim)]">
            <li>
              <b>Rush</b> — może atakować w rundzie wejścia.
            </li>
            <li>
              <b>Guard</b> — wrogowie muszą atakować tę jednostkę najpierw.
            </li>
            <li>
              <b>Ranged</b> — atakując, nie otrzymuje retaliacji.
            </li>
            <li>
              <b>Zatrucie X</b> — traci X HP na koniec każdej rundy.
            </li>
            <li>
              <b>Przeciążenie X</b> — nie może atakować przez X rund.
            </li>
            <li>
              <b>Zamrożenie</b> — pomija najbliższą szansę na atak.
            </li>
          </ul>
        </section>
        <section>
          <h2 className="text-lg font-bold text-white">Talia</h2>
          <p className="mt-1 text-[var(--text-dim)]">
            Dokładnie 20 kart, maks. 2 kopie karty (1 dla Legendary), jedna frakcja + dowolne karty Neutralne, min.
            10 jednostek.
          </p>
        </section>
      </div>
    </main>
  );
}
