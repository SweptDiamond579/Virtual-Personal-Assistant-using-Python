import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "JARVIS OS",
  description: "Personal AI operating environment",
  manifest: "/manifest.webmanifest",
  applicationName: "JARVIS OS",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "JARVIS" },
  icons: { icon: "/icons/icon.svg", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#010309",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
