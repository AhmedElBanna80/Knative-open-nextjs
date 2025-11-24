"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const HANDLER_PATH = process.env.NEXT_HANDLER_PATH;
const PROJECT_ROOT = process.env.NEXT_PROJECT_ROOT || '.';
async function optimize() {
    if (!HANDLER_PATH) {
        console.log('No NEXT_HANDLER_PATH provided. Starting full server.');
        return;
    }
    console.log(`Optimizing runtime for handler: ${HANDLER_PATH}`);
    console.log(`Project root: ${PROJECT_ROOT}`);
    const manifestPath = path_1.default.join(process.cwd(), PROJECT_ROOT, '.next', 'routes-manifest.json');
    if (!fs_1.default.existsSync(manifestPath)) {
        console.warn(`Manifest not found at ${manifestPath}. Skipping optimization.`);
        return;
    }
    try {
        const manifestContent = fs_1.default.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);
        // Filter Static Routes
        const originalStaticCount = manifest.staticRoutes.length;
        manifest.staticRoutes = manifest.staticRoutes.filter((r) => {
            return r.page === HANDLER_PATH || r.page === '/_not-found' || r.page === '/404';
        });
        // Filter Dynamic Routes
        const originalDynamicCount = manifest.dynamicRoutes.length;
        manifest.dynamicRoutes = manifest.dynamicRoutes.filter((r) => {
            return r.page === HANDLER_PATH;
        });
        console.log(`Optimized Manifest:`);
        console.log(` - Static Routes: ${originalStaticCount} -> ${manifest.staticRoutes.length}`);
        console.log(` - Dynamic Routes: ${originalDynamicCount} -> ${manifest.dynamicRoutes.length}`);
        fs_1.default.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log('Manifest updated successfully.');
    }
    catch (error) {
        console.error('Error optimizing manifest:', error);
    }
}
// Run optimization then start server
optimize().then(() => {
    console.log('Starting Next.js server...');
    // We use require to load the server.js which is in the same directory in the container
    try {
        const serverPath = path_1.default.join(process.cwd(), PROJECT_ROOT, 'server.js');
        console.log(`Requiring server from: ${serverPath}`);
        require(serverPath);
    }
    catch (e) {
        console.error('Failed to start server.js:', e);
        process.exit(1);
    }
});
