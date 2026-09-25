import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// With `globals: false` in vite.config.ts, Testing Library's automatic
// afterEach-based cleanup (which looks for a global `afterEach`) never
// registers, so each render() would otherwise accumulate in the DOM across
// tests in the same file.
afterEach(() => {
  cleanup();
});

