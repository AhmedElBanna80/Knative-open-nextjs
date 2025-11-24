import fs from 'fs-extra';
import path from 'path';
import { RouteGroup } from './splitter';

export class Generator {
  private outputDir: string;
  private imageName: string;
  private namespace: string;

  constructor(outputDir: string, imageName: string, namespace: string = 'default') {
    this.outputDir = outputDir;
    this.imageName = imageName;
    this.namespace = namespace;
  }

  async generate(groups: RouteGroup[]) {
    await fs.ensureDir(this.outputDir);

    // 1. Generate Knative Services
    for (const group of groups) {
      const serviceYaml = this.generateServiceYaml(group);
      await fs.writeFile(path.join(this.outputDir, `service-${group.name}.yaml`), serviceYaml);
    }

    // 2. Generate VirtualService (Routing)
    const vsYaml = this.generateVirtualServiceYaml(groups);
    await fs.writeFile(path.join(this.outputDir, 'virtual-service.yaml'), vsYaml);
  }

  private generateServiceYaml(group: RouteGroup): string {
    return `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: next-${group.name}
  namespace: ${this.namespace}
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "0"
        # Fluid Compute emulation: Allow high concurrency per instance
        autoscaling.knative.dev/target: "100" 
    spec:
      containers:
        - image: ${this.imageName}
          env:
            - name: NEXT_HANDLER_PATH
              value: "${group.paths[0]}" # Hint to runtime which page to optimize for (optional)
            - name: CERBOS_URL
              value: "cerbos.default.svc.cluster.local:3593"
            - name: MINIO_ENDPOINT
              value: "minio.default.svc.cluster.local"
            - name: MINIO_PORT
              value: "9000"
            - name: MINIO_USE_SSL
              value: "false"
            # In a real app, use a Secret for the DB URL
            - name: DATABASE_URL
              value: "postgresql://neondb_owner:password@neon-cluster-main.default.svc.cluster.local:5432/neondb?sslmode=require"
            - name: MINIO_ACCESS_KEY
              value: "minio" # POC default
            - name: MINIO_SECRET_KEY
              value: "minio123" # POC default
          ports:
            - containerPort: 3000
`;
  }

  private generateVirtualServiceYaml(groups: RouteGroup[]): string {
    const routes = groups.map(group => {
      // Simple path matching. For regex/dynamic routes, Istio supports regex.
      // Next.js regex needs to be converted to Istio regex if complex.
      // For now, we use exact match for static and prefix/regex for dynamic.

      const matchers = group.paths.map(p => {
        if (p.includes('[')) {
          // Convert Next.js dynamic route /blog/[slug] to regex /blog/.*
          // This is a simplification.
          const regex = '^' + p.replace(/\[.*?\]/g, '.*') + '.*';
          return `    - uri:
        regex: "${regex}"`;
        } else {
          return `    - uri:
        exact: "${p}"`;
        }
      }).join('\n');

      return `
  - match:
${matchers}
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
