import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  basePath: '/dashboard',
  assetPrefix: '/dashboard-static',
  transpilePackages: ['@knative-next/ui', '@knative-next/framework'],
  experimental: {
    turbo: {
      rules: {
        '*.svg': {
          loaders: ['@svgr/webpack'],
          as: '*.js',
        },
      },
    },
  },
};

export default nextConfig;

