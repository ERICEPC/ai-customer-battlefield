import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  transpilePackages: ["@battlefield/contracts"],
};

export default nextConfig;
