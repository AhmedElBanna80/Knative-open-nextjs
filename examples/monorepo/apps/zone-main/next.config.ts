/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  assetPrefix: process.env.ASSET_PREFIX,
  // cacheComponents disabled for now due to conflict with dynamic routes
  experimental: {
    instrumentationHook: false,
    serverActions: {
      allowedOrigins: ['localhost:8080', 'next-index.default.svc.cluster.local']
    }
  },

};

export default nextConfig;
