//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-harness-extras`.
* @module @deepseek-ai/dsh-client-ui-harness-extras/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-harness-extras";
/** Cordis companion plugin name. */
const name = "client-ui-harness-extras-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the settings sections are registry-owned
* registrations whose disposal is proven by the HMR-safety spec. They emit
* no cordis events and own no cross-plugin mutable state.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
