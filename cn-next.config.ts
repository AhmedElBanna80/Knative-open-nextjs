import { type OpenNextConfig } from './packages/cn-next/src/config';

const config: OpenNextConfig = {
    name: "file-manager",
    distribution_mode: "page", // Granular distribution
    infrastructure: {
        kubernetes_host: process.env.KUBECONFIG_CONTEXT || "minikube",
        s3_service: {
            endpoint: "https://s3.amazonaws.com", // or MinIO URL
            bucket: "nextjs-assets",
            region: "us-east-1",
            access_key: process.env.S3_ACCESS_KEY || "change-me",
            secret_key: process.env.S3_SECRET_KEY || "change-me",
            public_url: "https://cdn.example.com",
        },
        database_service: {
            connection_string: process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/db"
        },
        docker_registry: process.env.DOCKER_REGISTRY || "ttl.sh/knative-next"
    },
    build: {
        base_image: "oven/bun:alpine"
    }
};

export default config;
