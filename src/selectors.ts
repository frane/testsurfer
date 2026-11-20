/**
 * Playwright's `selectors` object. setTestIdAttribute() changes the
 * attribute getByTestId() reads, for every page from then on, unless a
 * page's own testIdAttribute option says otherwise.
 */
export const selectorSettings: { testIdAttribute: string | null } = { testIdAttribute: null };

export const selectors = {
  setTestIdAttribute(name: string): void {
    selectorSettings.testIdAttribute = name;
  },
  /** Custom selector engines run page-side code testsurfer does not load. */
  async register(name: string): Promise<never> {
    throw new Error(`selectors.register("${name}"): custom selector engines are not supported`);
  },
};
