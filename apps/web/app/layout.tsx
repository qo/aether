import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { AppShell } from "../features/shell/app-shell";
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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400..700;1,400..700&display=swap"
          rel="stylesheet"
        />
      </head>
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
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
