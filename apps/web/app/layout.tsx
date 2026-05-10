import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { DevBootstrap } from "../lib/devlog";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap"
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Aether",
  description: "Local-first Wi-Fi CSI sensing instrument"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetBrainsMono.variable}`}>
      {/*
        suppressHydrationWarning on <body> only: browser extensions (Bitdefender,
        password managers, etc.) inject attributes like `bis_register` and
        `__processed_*` onto <body> before React hydrates. Without this flag
        every page load logs a hydration mismatch even though our markup is
        correct. We do NOT add this on <html> or any descendant — we want real
        mismatches in the React tree to keep failing loudly.
      */}
      <body suppressHydrationWarning>
        <DevBootstrap />
        {children}
      </body>
    </html>
  );
}
