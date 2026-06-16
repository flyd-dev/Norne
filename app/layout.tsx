import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Norne — intern assistent",
  description: "Intern chatbot for spørsmål om prosjekter, kontoer og budsjett.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}
