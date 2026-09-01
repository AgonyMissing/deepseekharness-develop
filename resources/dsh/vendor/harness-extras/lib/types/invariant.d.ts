declare const name = "client-ui-harness-extras-invariant";
declare const inject: string[];
declare const apply: (ctx: {
    invariants: {
        register(name: string, install: () => void): unknown;
    };
}) => Promise<unknown>;
export { apply, inject, name };
