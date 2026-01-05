"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Validator = void 0;
const node_path_1 = __importDefault(require("node:path"));
const fs_extra_1 = __importDefault(require("fs-extra"));
class Validator {
    constructor(projectDir) {
        this.projectDir = projectDir;
    }
    async validate() {
        await this.validateAppRouter();
        await this.validatePPR();
    }
    async validateAppRouter() {
        const pagesDir = node_path_1.default.join(this.projectDir, 'pages');
        const appDir = node_path_1.default.join(this.projectDir, 'app');
        const srcPagesDir = node_path_1.default.join(this.projectDir, 'src', 'pages');
        const srcAppDir = node_path_1.default.join(this.projectDir, 'src', 'app');
        const hasAppDir = (await fs_extra_1.default.pathExists(appDir)) || (await fs_extra_1.default.pathExists(srcAppDir));
        const hasPagesDir = (await fs_extra_1.default.pathExists(pagesDir)) || (await fs_extra_1.default.pathExists(srcPagesDir));
        if (!hasAppDir) {
            throw new Error('Validation Failed: Strictly App Router is required, but no "app" directory found.');
        }
        if (hasPagesDir) {
            // Check if pages dir only contains api routes, which might be acceptable,
            // but user said "strictly using app router", so we should probably be strict.
            // However, Next.js often keeps pages/api. Let's check if there are non-api routes.
            const pagesPath = (await fs_extra_1.default.pathExists(pagesDir)) ? pagesDir : srcPagesDir;
            const files = await fs_extra_1.default.readdir(pagesPath);
            const nonApiFiles = files.filter((f) => f !== 'api' &&
                f !== '_app.tsx' &&
                f !== '_document.tsx' &&
                f !== '_app.js' &&
                f !== '_document.js' &&
                f !== '_app.ts' &&
                f !== '_document.ts');
            if (nonApiFiles.length > 0) {
                throw new Error(`Validation Failed: Strictly App Router is required, but "pages" directory contains routes: ${nonApiFiles.join(', ')}. Please migrate them to "app".`);
            }
        }
    }
    async validatePPR() {
        // We need to check next.config.js for cacheComponents (Next.js 16+) or experimental.ppr (Next.js 14/15)
        // Since we can't easily require() the user's config without potentially crashing or needing dependencies,
        // we will try to read it as text or check the build output if available.
        // A more robust way is to check the build output "prerender-manifest.json" or similar if we run after build.
        // But this validator runs before/during our compile step.
        // Let's try to read next.config.js/mjs/ts
        const configFiles = ['next.config.js', 'next.config.mjs', 'next.config.ts'];
        let configContent = '';
        for (const file of configFiles) {
            const filePath = node_path_1.default.join(this.projectDir, file);
            if (await fs_extra_1.default.pathExists(filePath)) {
                configContent = await fs_extra_1.default.readFile(filePath, 'utf-8');
                break;
            }
        }
        if (!configContent) {
            console.warn('⚠️  Could not find next.config.js to validate PPR. Assuming it is configured.');
            return;
        }
        // Check for cacheComponents (Next.js 16+) or experimental.ppr (Next.js 14/15)
        const hasPPR = /cacheComponents:\s*true/.test(configContent) ||
            /ppr:\s*true/.test(configContent) ||
            /partialPrerendering:\s*true/.test(configContent);
        if (!hasPPR) {
            console.warn('⚠️  Partial Prerendering (PPR) is not enabled. For Next.js 16+, set "cacheComponents: true". For Next.js 14/15, set "experimental.ppr: true".');
        }
        else {
        }
    }
}
exports.Validator = Validator;
