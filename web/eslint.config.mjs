import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: ["e2e/**", "playwright-report/**", "test-results/**", "scripts/**"],
  },
];

export default eslintConfig;
