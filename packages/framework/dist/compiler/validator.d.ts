export declare class Validator {
    private projectDir;
    constructor(projectDir: string);
    validate(): Promise<void>;
    private validateAppRouter;
    private validatePPR;
}
