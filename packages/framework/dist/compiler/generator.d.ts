import { RouteGroup } from './splitter';
export declare class Generator {
    private outputDir;
    private imageName;
    private namespace;
    private envConfig;
    private projectRoot;
    constructor(outputDir: string, imageName: string, namespace?: string, envConfig?: Record<string, string>, projectRoot?: string);
    generate(groups: RouteGroup[]): Promise<void>;
    private generateServiceYaml;
    private generateVirtualServiceYaml;
}
