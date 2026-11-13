import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aevyra Messaging Gateway",
  description: "Развојна околина за Aevyra Messaging Gateway.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="mk">
      <body>{children}</body>
    </html>
  );
}
