import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { safeReportingConfig } from '../observability/config.ts';
import { ErrorReporting } from './error-reporting.tsx';
import './globals.css';

export const metadata: Metadata = {
  title: 'Page Shop',
  description: 'Demo shop that PageAgents keeps running',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <Link href="/">
            <strong>Page Shop</strong>
          </Link>
          <Link href="/cart">Cart</Link>
        </header>
        {children}
        <ErrorReporting config={safeReportingConfig()} />
      </body>
    </html>
  );
}
