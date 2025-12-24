import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@knative-next/ui'],
  async rewrites() {
    return [
      // Dashboard zone
      {
        source: '/dashboard',
        destination: `${process.env.DASHBOARD_URL || 'http://localhost:3001'}/dashboard`,
      },
      {
        source: '/dashboard/:path*',
        destination: `${process.env.DASHBOARD_URL || 'http://localhost:3001'}/dashboard/:path*`,
      },
      {
        source: '/dashboard-static/:path*',
        destination: `${process.env.DASHBOARD_URL || 'http://localhost:3001'}/dashboard-static/:path*`,
      },
      // Users zone
      {
        source: '/users',
        destination: `${process.env.USERS_URL || 'http://localhost:3002'}/users`,
      },
      {
        source: '/users/:path*',
        destination: `${process.env.USERS_URL || 'http://localhost:3002'}/users/:path*`,
      },
      {
        source: '/users-static/:path*',
        destination: `${process.env.USERS_URL || 'http://localhost:3002'}/users-static/:path*`,
      },
    ];
  },
};

export default nextConfig;

