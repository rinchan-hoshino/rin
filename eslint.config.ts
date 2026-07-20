import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".test-dist/**",
      "node_modules/**",
      "third_party/**",
      "upstream/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-empty": "off",
      "no-extra-boolean-cast": "off",
      "no-undef": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "Use the Rin-owned HTTP transport instead of process-global fetch.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "undici",
              message: "Import Undici only through the Rin HTTP transport.",
            },
            {
              name: "node-fetch",
              message: "Use the Rin-owned HTTP transport.",
            },
          ],
          patterns: [
            {
              group: ["undici/*", "node-fetch/*"],
              message: "Use the Rin-owned HTTP transport.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name=/^(global|globalThis)$/][property.name='fetch']",
          message:
            "Use the Rin-owned HTTP transport instead of process-global fetch.",
        },
        {
          selector:
            "MemberExpression[object.name=/^(global|globalThis)$/][computed=true][property.value='fetch']",
          message:
            "Use the Rin-owned HTTP transport instead of process-global fetch.",
        },
        {
          selector:
            "VariableDeclarator[init.name=/^(global|globalThis)$/] Property[key.name='fetch']",
          message:
            "Do not destructure process-global fetch; use the Rin HTTP transport.",
        },
        {
          selector:
            "VariableDeclarator[init.name=/^(global|globalThis)$/] Property[key.value='fetch']",
          message:
            "Do not destructure process-global fetch; use the Rin HTTP transport.",
        },
        {
          selector: "ImportExpression[source.value=/^undici(?:\\/|$)/]",
          message: "Import Undici only through the Rin HTTP transport.",
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^undici(?:\\/|$)/]",
          message: "Import Undici only through the Rin HTTP transport.",
        },
      ],
    },
  },
  {
    files: ["src/core/http/transport.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
