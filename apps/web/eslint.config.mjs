import next from "eslint-config-next";

const config = [...next, { ignores: [".next/**", "next-env.d.ts"] }, { rules: { "@typescript-eslint/no-explicit-any": "off" } }];
export default config;
