import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  basePath: '/users',
  assetPrefix: '/users-static',
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

