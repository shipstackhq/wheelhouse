import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { PwaRegister } from "@/components/pwa";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const viewport: Viewport = { themeColor: "#2563eb" };

export const metadata: Metadata = {
  applicationName: "Wheelhouse",
  appleWebApp: { capable: true, title: "Wheelhouse" },
  title: "Shipstack Wheelhouse",
  description: "Kanban boards and architecture maps your team and your AI agents share.",
};

// Runs before first paint so there's no dark→light flash.
const themeScript = `(function(){try{var m=localStorage.getItem("wh_theme")||"system";var l=m==="light"||(m==="system"&&window.matchMedia("(prefers-color-scheme: light)").matches);document.documentElement.dataset.theme=l?"light":"dark"}catch(e){document.documentElement.dataset.theme="dark"}})()`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>{children}
        <PwaRegister />
      </body>
    </html>
  );
}
