// On top of playwright.config.ts: every request through vibesurfer's
// proxy, so documents can be routed and popups open as pages.
export default { network: 'proxy' };
