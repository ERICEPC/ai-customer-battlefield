import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SessionProvider } from "../src/auth/session-provider";

import "./globals.css";

export const metadata: Metadata = {
  title: "AI 客户作战系统",
  description: "面向销售团队的可确认、可追溯客户经营工作台",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
