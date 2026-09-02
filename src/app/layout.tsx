import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TaskFlow — Unified AI API & Infrastructure Platform",
  description:
    "One OpenAI-compatible API for AI models with usage credits, token-level tracking, API keys and rate limits. Subscribe, get credits, call AI, scale up — all through TaskFlow.",
  keywords: ["AI API", "AI gateway", "API keys", "usage credits", "AI infrastructure", "GPU hosting", "TaskFlow"],
  authors: [{ name: "TaskFlow" }],
  openGraph: {
    title: "TaskFlow — Unified AI API & Infrastructure Platform",
    description:
      "One API for every model. Credit-based billing, token-level usage tracking, and managed AI infrastructure.",
    siteName: "TaskFlow",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
