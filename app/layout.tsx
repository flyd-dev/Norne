import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Norne Assistent",
  description:
    "Intern prosjektassistent — spør om prosjekter, budsjettlinjer og mengder.",
  icons: {
    icon: "/brand/norne-symbol-dark.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="no">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
