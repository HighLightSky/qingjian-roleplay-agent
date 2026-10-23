import type { Metadata } from "next";
import { AppTheme } from "@/components/app-theme";

import "./globals.css";

export const metadata: Metadata = {
  title: "青笺 · 角色与故事",
  description: "与角色续写故事，让重要的事留在记忆里。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-dvh" suppressHydrationWarning>
      <body className="h-dvh font-sans">
        <AppTheme />
        {children}
      </body>
    </html>
  );
}
