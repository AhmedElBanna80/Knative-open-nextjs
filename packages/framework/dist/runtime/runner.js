"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const HANDLER_PATH = process.env.NEXT_HANDLER_PATH;
const PROJECT_ROOT = process.env.NEXT_PROJECT_ROOT || '.';
async function optimize() {
    if (!HANDLER_PATH) {
        return;
    }
    const manifestPath = node_path_1.default.join(process.cwd(), PROJECT_ROOT, '.next', 'routes-manifest.json');
    if (!node_fs_1.default.existsSync(manifestPath)) {
        console.warn(`Manifest not found at ${manifestPath}. Skipping optimization.`);
        return;
    }
    try {
        const manifestContent = node_fs_1.default.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);
        // Filter Static Routes
        const _originalStaticCount = manifest.staticRoutes.length;
        manifest.staticRoutes = manifest.staticRoutes.filter((r) => {
            return r.page === HANDLER_PATH || r.page === '/_not-found' || r.page === '/404';
        });
        // Filter Dynamic Routes
        const _originalDynamicCount = manifest.dynamicRoutes.length;
        manifest.dynamicRoutes = manifest.dynamicRoutes.filter((r) => {
            return r.page === HANDLER_PATH;
        });
        node_fs_1.default.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    catch (error) {
        console.error('Error optimizing manifest:', error);
    }
}
// Run optimization then start server
optimize().then(() => {
    // We use require to load the server.js which is in the same directory in the container
    try {
        const serverPath = node_path_1.default.join(process.cwd(), PROJECT_ROOT, 'server.js');
        require(serverPath);
    }
    catch (e) {
        console.error('Failed to start server.js:', e);
        process.exit(1);
    }
});
