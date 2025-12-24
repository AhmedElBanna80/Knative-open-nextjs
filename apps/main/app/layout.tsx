import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'File Manager - Multi-Zone',
  description: 'File management system with multi-zone architecture',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900">
        <nav className="bg-black/20 border-b border-white/10">
          <div className="container mx-auto px-4 py-4">
            <div className="flex items-center justify-between">
              <Link href="/" className="text-2xl font-bold text-white">
                File Manager
              </Link>
              <div className="flex gap-4">
                <Link href="/" className="text-white hover:text-purple-300 transition">
                  Home
                </Link>
                <Link href="/dashboard" className="text-white hover:text-purple-300 transition">
                  Dashboard
                </Link>
                <Link href="/users" className="text-white hover:text-purple-300 transition">
                  Users
                </Link>
              </div>
            </div>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}

