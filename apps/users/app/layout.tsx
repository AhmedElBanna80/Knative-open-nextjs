import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Users - File Manager',
  description: 'User management zone',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900">
        {children}
      </body>
    </html>
  );
}

