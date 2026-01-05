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
  env: {
    CERBOS_URL: "cerbos.default.svc.cluster.local:3593",
    MINIO_ENDPOINT: "minio.default.svc.cluster.local",
    MINIO_PORT: "80",
    MINIO_USE_SSL: "false",
    DATABASE_URL: "postgresql://neondb_owner:password@postgres.default.svc.cluster.local:5432/neondb?sslmode=disable",
    MINIO_ACCESS_KEY: "minio",
    MINIO_SECRET_KEY: "minio123"
  }
};

export default nextConfig;
