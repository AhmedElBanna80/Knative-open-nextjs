import path from 'node:path';
import fs from 'fs-extra';

interface Route {
  page: string;
  regex: string;
}

interface RoutesManifest {
  version: number;
  pages404: boolean;
  basePath: string;
  redirects: any[];
  headers: any[];
  dynamicRoutes: Route[];
  staticRoutes: Route[];
  dataRoutes: any[];
  i18n?: any;
}

export interface RouteGroup {
  name: string;
  paths: string[];
  regex: string[];
}

export class Splitter {
  private nextDir: string;

  constructor(nextDir: string) {
    this.nextDir = nextDir;
  }

  async analyze(): Promise<RouteGroup[]> {
    const manifestPath = path.join(this.nextDir, 'routes-manifest.json');
    if (!(await fs.pathExists(manifestPath))) {
      throw new Error(`Could not find routes-manifest.json at ${manifestPath}`);
    }

    const manifest: RoutesManifest = await fs.readJSON(manifestPath);
    const groups: RouteGroup[] = [];

    // Force Monolith
    const allPaths: string[] = [];
    const allRegex: string[] = [];

    for (const route of manifest.staticRoutes) {
      allPaths.push(route.page);
      allRegex.push(route.regex);
    }
    for (const route of manifest.dynamicRoutes) {
      allPaths.push(route.page);
      allRegex.push(route.regex);
    }

    return [{
      name: 'index',
      paths: allPaths,
      regex: allRegex,
    }];
  }

  private sanitizeName(page: string): string {
    // Convert /blog/[slug] to blog-slug
    // Convert / to index
    if (page === '/') return 'index';

    let name = page
      .replace(/^\//, '')
      .replace(/\/\[/g, '-')
      .replace(/\]/g, '')
      .replace(/\//g, '-')
      .toLowerCase();

    // Fix for Knative/K8s naming constraints (RFC 1123)
    // Must consist of lower case alphanumeric characters, '-' or '.',
    // and must start and end with an alphanumeric character.

    // Replace invalid chars (like underscore) with hyphen
    name = name.replace(/[^a-z0-9-]/g, '-');

    // Remove leading/trailing hyphens
    name = name.replace(/^-+|-+$/g, '');

    return name;
  }
}
