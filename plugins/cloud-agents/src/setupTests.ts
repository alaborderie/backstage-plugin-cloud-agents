import '@testing-library/jest-dom';

// jsdom lacks ResizeObserver and element scrolling, which the agent page uses.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollTo ??= () => {};
