import { z } from 'zod';

// Infrastructure Target Configuration
const InfrastructureSchema = z.object({
    // Kubernetes API endpoint or Kubeconfig context
    kubernetes_host: z.string().describe("Kubernetes API URL or Context Name"),

    // S3 Compatible Service for Static Assets
    s3_service: z.object({
        endpoint: z.string().url(),
        bucket: z.string(),
        region: z.string().optional().default("us-east-1"),
        access_key: z.string().min(1),
        secret_key: z.string().min(1),
        public_url: z.string().url().describe("Publicly accessible URL/CDN for assets"),
        use_ssl: z.boolean().default(true)
    }).describe("S3 Compatible Object Storage Config"),

    // Database Connection
    database_service: z.object({
        connection_string: z.string().describe("PostgreSQL Connection String"),
        pool_config: z.object({
            min: z.number().default(0),
            max: z.number().default(10)
        }).optional()
    }).describe("Database Configuration")
});

// Granularity Strategy
const DistributionModeSchema = z.enum(["zone", "page"]).describe(
    "zone: One service per Multi-Zone app. page: One service per Next.js Route."
);

export const OpenNextConfigSchema = z.object({
    name: z.string().min(1),
    distribution_mode: DistributionModeSchema.default("page"),
    infrastructure: InfrastructureSchema,

    // Optional Build Overrides
    build: z.object({
        base_image: z.string().default("oven/bun:alpine"),
        node_version: z.string().optional(),
        bun_version: z.string().optional()
    }).optional()
});

export type OpenNextConfig = z.infer<typeof OpenNextConfigSchema>;

export function validateConfig(config: unknown): OpenNextConfig {
    return OpenNextConfigSchema.parse(config);
}
