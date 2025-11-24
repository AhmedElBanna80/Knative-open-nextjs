import { RouteGroup } from './splitter';
export declare class Generator {
    private outputDir;
    private imageName;
    private namespace;
    constructor(outputDir: string, imageName: string, namespace?: string);
    generate(groups: RouteGroup[]): Promise<void>;
    private generateServiceYaml;
    private generateVirtualServiceYaml;
}
