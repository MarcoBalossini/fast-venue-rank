// Single namespace for Chrome (chrome.*) and Firefox (browser.*).
// Both return promises when no callback is passed, so all call sites use await.
// eslint-disable-next-line no-unused-vars
const api = globalThis.browser ?? globalThis.chrome;
