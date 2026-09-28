import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";

it("uses public SDK contracts and declared UI dependencies", () => {
  const result = experimental_scanPublicSdkOnly(
    fileURLToPath(new URL("..", import.meta.url)),
    {
      allow: [
        /^react$/,
        /^@testing-library\/react$/,
        /^@radix-ui\/react-slot$/,
        /^class-variance-authority$/,
        /^clsx$/,
        /^tailwind-merge$/,
      ],
    },
  );
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});
