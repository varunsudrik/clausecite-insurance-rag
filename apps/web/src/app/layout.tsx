import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NavBar } from '@/components/nav-bar';
import './globals.css';

export const metadata: Metadata = {
  title: 'ClauseCite — insurance policy answers with citations',
  description:
    'Ask questions about health insurance policy wordings and get answers cited to the exact clause and page.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <NavBar />
        <main className="mx-auto w-full max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
