import type { Metadata } from "next";
import { WalletProviders } from "@/components/WalletProviders";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mines",
  description: "Provably-fair Mines on X1",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
