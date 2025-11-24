"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Generator = void 0;
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
class Generator {
    constructor(outputDir, imageName, namespace = 'default', envConfig = {}, projectRoot = '.') {
        this.outputDir = outputDir;
        this.imageName = imageName;
        this.namespace = namespace;
        this.projectRoot = projectRoot;
        this.envConfig = {
            CERBOS_URL: "cerbos.default.svc.cluster.local:3593",
            MINIO_ENDPOINT: "minio.default.svc.cluster.local",
            MINIO_PORT: "9000",
            MINIO_USE_SSL: "false",
            DATABASE_URL: "postgresql://neondb_owner:password@postgres-postgresql.default.svc.cluster.local:5432/neondb?sslmode=disable",
            MINIO_ACCESS_KEY: "minio",
            MINIO_SECRET_KEY: "minio123",
            ...envConfig
        };
    }
    async generate(groups) {
        await fs_extra_1.default.ensureDir(this.outputDir);
        // 1. Generate Knative Services
        for (const group of groups) {
            const serviceYaml = this.generateServiceYaml(group);
            await fs_extra_1.default.writeFile(path_1.default.join(this.outputDir, `service-${group.name}.yaml`), serviceYaml);
        }
        // 2. Generate VirtualService (Routing)
        const vsYaml = this.generateVirtualServiceYaml(groups);
        await fs_extra_1.default.writeFile(path_1.default.join(this.outputDir, 'virtual-service.yaml'), vsYaml);
    }
    generateServiceYaml(group) {
        const envVars = Object.entries(this.envConfig).map(([key, value]) => `            - name: ${key}
              value: "${value}"`).join('\n');
        return `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: next-${group.name}
  namespace: ${this.namespace}
  annotations:
    serving.knative.dev/digestResolution: "skipped"
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "0"
        # Fluid Compute emulation: Allow high concurrency per instance
        autoscaling.knative.dev/target: "100"
        # Skip digest resolution for local images
        serving.knative.dev/digestResolution: "skipped"
    spec:
      containers:
        - image: ${this.imageName}
          imagePullPolicy: Never
          env:
            - name: NEXT_HANDLER_PATH
              value: "${group.paths[0]}" # Hint to runtime which page to optimize for (optional)
            - name: NEXT_PROJECT_ROOT
              value: "${this.projectRoot}"
${envVars}
          ports:
            - containerPort: 3000
`;
    }
    generateVirtualServiceYaml(groups) {
        const routes = groups.map(group => {
            // Simple path matching. For regex/dynamic routes, Istio supports regex.
            // Next.js regex needs to be converted to Istio regex if complex.
            // For now, we use exact match for static and prefix/regex for dynamic.
            const matchers = group.paths.map(p => {
                if (p.includes('[')) {
                    // Convert Next.js dynamic route /blog/[slug] to regex /blog/[^/]+
                    // Handle catch-all [...slug] -> .*
                    let regex = p;
                    // Handle catch-all [...param]
                    regex = regex.replace(/\/\[\.\.\..*?\]/g, '/.*');
                    // Handle single param [param]
                    regex = regex.replace(/\/\[.*?\]/g, '/[^/]+');
                    // Ensure start anchor, and if it doesn't end with .*, ensure end anchor (or handle subpaths?)
                    // Next.js routes are exact matches unless catch-all.
                    // But /blog/[slug] should match /blog/foo but NOT /blog/foo/bar
                    regex = '^' + regex + '$';
                    return `    - uri:
        regex: "${regex}"`;
                }
                else {
                    return `    - uri:
        exact: "${p}"`;
                }
            }).join('\n');
            return `
  - match:
${matchers}
    rewrite:
      authority: next-${group.name}.${this.namespace}.svc.cluster.local
    route:
    - destination:
        host: next-${group.name}.${this.namespace}.svc.cluster.local
`;
        }).join('\n');
        return `
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: next-app-router
  namespace: ${this.namespace}
spec:
  hosts:
  - "*"
  gateways:
  - knative-serving/knative-ingress-gateway # Assuming standard Knative setup
  http:
${routes}
`;
    }
}
exports.Generator = Generator;
