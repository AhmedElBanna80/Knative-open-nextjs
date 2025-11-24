export default class RedisCacheHandler {
    private client;
    private options;
    constructor(options: any);
    get(key: string): Promise<any>;
    set(key: string, data: any, ctx: any): Promise<void>;
    revalidateTag(tag: string): Promise<void>;
}
