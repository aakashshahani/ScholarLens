import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { LeftRail } from "@/components/left-rail";
import { CommandPalette } from "@/components/command-palette";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: "ScholarLens — Research Intelligence",
  description: "An AI reasoning system for scientific literature — contradictions, consensus shifts, and hypothesis generation.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`h-full ${inter.variable} ${geistMono.variable}`}>
      <body className="min-h-full antialiased">
        <LeftRail />
        <CommandPalette />
        <main className="pl-[60px] min-h-screen">
          <div className="max-w-[1180px] mx-auto px-8 py-8">{children}</div>
        </main>
      </body>
    </html>
  );
}
