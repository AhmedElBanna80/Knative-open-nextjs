"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Splitter = void 0;
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
class Splitter {
    constructor(nextDir) {
        this.nextDir = nextDir;
    }
    async analyze() {
        const manifestPath = path_1.default.join(this.nextDir, 'routes-manifest.json');
        if (!await fs_extra_1.default.pathExists(manifestPath)) {
            throw new Error(`Could not find routes-manifest.json at ${manifestPath}`);
        }
        const manifest = await fs_extra_1.default.readJSON(manifestPath);
        const groups = [];
        // Strategy: One service per page (granular splitting)
        // In a real app, we might want to group some (e.g. /blog/*)
        // Process Static Routes
        for (const route of manifest.staticRoutes) {
            groups.push({
                name: this.sanitizeName(route.page),
                paths: [route.page],
                regex: [route.regex]
            });
        }
        // Process Dynamic Routes
        for (const route of manifest.dynamicRoutes) {
            groups.push({
                name: this.sanitizeName(route.page),
                paths: [route.page], // This is the pattern, e.g., /blog/[slug]
                regex: [route.regex]
            });
        }
        return groups;
    }
    sanitizeName(page) {
        // Convert /blog/[slug] to blog-slug
        // Convert / to index
        if (page === '/')
            return 'index';
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
exports.Splitter = Splitter;
