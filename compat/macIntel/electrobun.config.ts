import type { ElectrobunConfig } from "electrobun";
import shared from "./generated/config.json";

export default {
  app: shared.app,
  build: {
    // ACT: 与主桌面构建一致，保留 Photon、anydoc 原包及其相邻 WASM/原生文件。
    bun: { entrypoint: "generated/src/index.ts", minify: true, external: ["@silvia-odwyer/photon-node", "@firecrawl/anydoc", "@firecrawl/anydoc-wasm"] },
    copy: {
      "../../build/desktop/photon": "bun/node_modules/@silvia-odwyer/photon-node",
      "../../build/desktop/node_modules/@firecrawl": "bun/node_modules/@firecrawl",
      "../../build/mcp": "mcp",
      "../../build/web": "views/mainview",
      "../../build/tools": "tools",
      "../../build/nodes": "nodes",
      "../../build/ext": "ext",
      "../../packages/providers/src": "providers",
      "../../packages/skills": "skills",
      "../../packages/startup/assets/startup.json": "startup/startup.json",
      "../../packages/startup/assets/license.txt": "startup/license.txt",
      "../../packages/startup/assets/macX64": "startup/macX64",
    },
    buildFolder: "../../build/desktop/macIntel",
    artifactFolder: "../../build/desktop/artifacts/macX64",
    mac: {
      icons: "../../packages/assets/logo.iconset",
      entitlements: { "com.apple.security.device.audio-input": true },
      // ACT: 原生 SDK 已预留签名空间；Intel 的 Developer ID 签名与公证仍需单独验证后开启。
      codesign: false,
      notarize: false,
    },
  },
  release: shared.release,
  scripts: {
    postBuild: "../../apps/desktop/scripts/localizeMac.ts",
    postWrap: "../../apps/desktop/scripts/localizeMac.ts",
  },
} satisfies ElectrobunConfig;
