import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  devIndicators: false,
  poweredByHeader: false,
  transpilePackages: ["@aevyra/config", "@aevyra/db"],
};

export default config;
