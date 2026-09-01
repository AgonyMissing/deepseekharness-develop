const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-harness-extras';
const name = 'client-ui-harness-extras-invariant';
const inject = ['invariants'];
const install = () => { };
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
export { apply, inject, name };
