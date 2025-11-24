export interface RouteGroup {
    name: string;
    paths: string[];
    regex: string[];
}
export declare class Splitter {
    private nextDir;
    constructor(nextDir: string);
    analyze(): Promise<RouteGroup[]>;
    private sanitizeName;
}
