import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

describe("package boundaries", () => {
  it("uses only public SDK and package-local imports", async () => {
    const result = await experimental_scanPublicSdkOnly(
      fileURLToPath(new URL(".", import.meta.url)),
      {
        allow: [
          /^vitest(?:\/config)?$/,
          /^@testing-library\//,
          /^@radix-ui\//,
          /^react(?:-dom)?$/,
          /^sonner$/,
          /^(?:class-variance-authority|clsx|tailwind-merge)$/,
          /^@\//,
        ],
      },
    );
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
