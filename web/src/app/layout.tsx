import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Node Clash — X1 Card Arena",
  description:
    "Node Clash: szybka gra karciana o kontrolę trzech węzłów sieci. Zagraj przeciw botowi za darmo.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
