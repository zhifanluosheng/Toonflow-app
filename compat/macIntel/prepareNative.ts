import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "@toonflow/file";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const minimumMacVersion = "13.0";

export default async function prepareNative() {
  if (process.platform !== "darwin" || process.arch !== "x64") throw new Error("Intel 原生 SDK 需要在 macOS x64 上准备。");
  const sdkDir = resolve(import.meta.dir, "node_modules/electrobun");
  const sdkVersion = JSON.parse(readFileSync(resolve(sdkDir, "package.json"), "utf8")).version;
  if (sdkVersion !== "1.18.1") throw new Error(`原生兼容构建仅适用于 Electrobun 1.18.1，当前为 ${sdkVersion}。`);
  const cacheDir = resolve(import.meta.dir, "node_modules/.toonflowNative");
  const distDir = resolve(sdkDir, "dist-macos-x64");
  const cmake = process.env.CMAKE || "cmake";
  const nativeEnv = { ...process.env, MACOSX_DEPLOYMENT_TARGET: minimumMacVersion };
  mkdirSync(cacheDir, { recursive: true });
  await $`${cmake} --version`.quiet();
  const sdkPath = (await $`xcrun --sdk macosx --show-sdk-path`.text()).trim();

  async function run(command: string[], cwd = cacheDir) {
    await $`${command}`.cwd(cwd).env(nativeEnv);
  }

  async function unpack(name: string, url: string, directory: string, hash: string, strip = true) {
    const archive = resolve(cacheDir, name);
    if (!existsSync(archive)) {
      console.log(`下载 Intel 原生构建输入：${name}`);
      const temporary = archive + ".download";
      try {
        await run(["curl", "-fL", "--retry", "3", "-o", temporary, url]);
        renameSync(temporary, archive);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== hash) {
      throw new Error(`构建输入校验失败，请移除后重试：${archive}`);
    }
    const marker = resolve(directory, ".sourceVersion");
    if (existsSync(marker) && readFileSync(marker, "utf8") === url) return;
    // ACT: 仅重建此脚本在 node_modules 下的固定缓存目录，下载失败不会留下可复用的半成品。
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    await run(["tar", "-xf", archive, ...(strip ? ["--strip-components=1"] : []), "-C", directory]);
    writeFileSync(marker, url);
  }

  const coreFiles = ["bun", "bsdiff", "bspatch", "launcher", "libNativeWrapper.dylib", "extractor", "zig-zstd", "zig-asar", "libasar.dylib"];
  if (coreFiles.some(name => !existsSync(resolve(distDir, name)))) {
    rmSync(resolve(distDir, ".sourceVersion"), { force: true });
    await unpack("core.tar.gz", "https://github.com/blackboardsh/electrobun/releases/download/v1.18.1/electrobun-core-darwin-x64.tar.gz", distDir, "8049f08f7d1dde0d7f536a5f03fec11e2ecd90c7b7edaf33d5e21910846e4df1", false);
  }

  const sourceDir = resolve(cacheDir, "electrobun");
  const zigDir = resolve(cacheDir, "zig");
  const asarDir = resolve(cacheDir, "zigAsar");
  const zstdDir = resolve(cacheDir, "zigZstd");
  const cefDir = resolve(cacheDir, "cef");
  const dawnDir = resolve(cacheDir, "dawn");
  await unpack("zig.tar.xz", "https://ziglang.org/download/0.13.0/zig-macos-x86_64-0.13.0.tar.xz", zigDir, "8b06ed1091b2269b700b3b07f8e3be3b833000841bae5aa6a09b1a8b4773effd");
  await unpack("electrobun.tar.gz", "https://codeload.github.com/blackboardsh/electrobun/tar.gz/4eba723c85b97559e1d9e13439d9a92ede0832e8", sourceDir, "ebac371b8f46604e860277e9b3557dfaaa6340715f9b92fa3e9e433dfa827ae7");
  await unpack("zigAsar.tar.gz", "https://codeload.github.com/blackboardsh/zig-asar/tar.gz/eea9a66e16ba2c65f1c0dc6a654f22b33c5951f1", asarDir, "f1b6873a69cb561895e3c9e5e2055c4a642704c270155ec5f55a31bf88bfcd53");
  await unpack("zigZstd.tar.gz", "https://codeload.github.com/blackboardsh/zig-zstd/tar.gz/60547303db2e97413a31383e64bb2b65a98c8295", zstdDir, "4492becd5dd755b11bee76421f910a771f4f94a1e663cebb2fd387c981713d1f");
  await unpack("zstd.tar.gz", "https://codeload.github.com/facebook/zstd/tar.gz/1168da0e567960d50cba1b58c9b0ba047ece4733", resolve(zstdDir, "zstd"), "055bdc23b537dfb4cb0927b7b1722d735b5713d5462167f6328bfa1ffeb7b722");

  const zig = resolve(zigDir, "zig");
  const packageDir = resolve(sourceDir, "package");
  for (const directory of [asarDir, zstdDir, resolve(packageDir, "src/launcher"), resolve(packageDir, "src/extractor")]) {
    const buildFile = resolve(directory, "build.zig");
    const code = readFileSync(buildFile, "utf8");
    // Zig 0.13 的 Intel 链接器默认不留签名空间，codesign 添加加载命令时会覆盖 __text。
    if (!code.includes(".headerpad_size = 0x1000;")) {
      writeFileSync(buildFile, code.replace(/b\.installArtifact\((\w+)\);/g, "$1.headerpad_size = 0x1000;\n    b.installArtifact($1);"));
    }
    console.log(`编译 Intel 原生组件：${directory}`);
    await run([zig, "build", `-Dtarget=x86_64-macos.${minimumMacVersion}`, "-Dcpu=baseline", "-Doptimize=ReleaseSmall", "--sysroot", sdkPath], directory);
  }

  await unpack("cef.tar.bz2", "https://cef-builds.spotifycdn.com/cef_binary_147.0.10+gd58e84d+chromium-147.0.7727.118_macosx64_minimal.tar.bz2", cefDir, "b7064a6c4a247a4f3b6964cbe38e463b2db8969f4a671dd1ca4abbf7284415a8");
  await unpack("dawn.tar.gz", "https://github.com/blackboardsh/electrobun-dawn/releases/download/v0.2.3/electrobun-dawn-darwin-x64.tar.gz", dawnDir, "233d0250affa19f7fbfaddeff3d96170adde90d04e9a3b8858b74fb9908478ca", false);
  const cefBuildDir = resolve(cefDir, "build");
  await run([cmake, "-S", cefDir, "-B", cefBuildDir, "-DPROJECT_ARCH=x86_64", "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_OSX_ARCHITECTURES=x86_64", `-DCMAKE_OSX_DEPLOYMENT_TARGET=${minimumMacVersion}`, "-DUSE_SANDBOX=OFF"]);
  await run([cmake, "--build", cefBuildDir, "--target", "libcef_dll_wrapper", "--parallel", "4"]);
  const nativeDir = resolve(packageDir, "src/native");
  const nativeObject = resolve(cacheDir, "nativeWrapper.o");
  const wrapperLibrary = resolve(cacheDir, "libNativeWrapper.dylib");
  const asarLibrary = resolve(asarDir, "zig-out/lib/libasar.dylib");
  const dawnInclude = existsSync(resolve(dawnDir, "include/dawn/webgpu.h")) ? resolve(dawnDir, "include") : resolve(dawnDir, "darwin-x64/include");
  await run(["xcrun", "--sdk", "macosx", "clang++", "-c", resolve(nativeDir, "macos/nativeWrapper.mm"), "-o", nativeObject, "-arch", "x86_64", `-mmacosx-version-min=${minimumMacVersion}`, "-Werror=unguarded-availability", "-fobjc-arc", "-fno-objc-msgsend-selector-stubs", `-I${cefDir}`, `-I${dawnInclude}`, "-std=c++20"]);
  await run(["xcrun", "--sdk", "macosx", "clang++", "-o", wrapperLibrary, nativeObject, asarLibrary, "-arch", "x86_64", `-mmacosx-version-min=${minimumMacVersion}`, ...["Cocoa", "WebKit", "QuartzCore", "Metal", "MetalKit", "UserNotifications"].flatMap(name => ["-framework", name]), `-F${resolve(cefDir, "Release")}`, "-weak_framework", "Chromium Embedded Framework", `-L${resolve(cefBuildDir, "libcef_dll_wrapper")}`, "-lcef_dll_wrapper", "-stdlib=libc++", "-shared", "-install_name", "@executable_path/libNativeWrapper.dylib", "-Wl,-rpath,@executable_path", "-Wl,-headerpad,0x1000"]);

  const outputs = [
    [resolve(packageDir, "src/launcher/zig-out/bin/launcher"), "launcher"],
    [resolve(packageDir, "src/extractor/zig-out/bin/extractor"), "extractor"],
    [resolve(asarDir, "zig-out/bin/zig-asar"), "zig-asar"],
    [asarLibrary, "libasar.dylib"],
    [resolve(zstdDir, "zig-out/bin/zig-zstd"), "zig-zstd"],
    [wrapperLibrary, "libNativeWrapper.dylib"],
  ] as const;
  for (const [source] of outputs) {
    const loadCommands = await $`otool -l ${source}`.text();
    const version = loadCommands.match(/^\s+minos\s+(\d+)\.(\d+)/m);
    if (version?.[1] !== "13" || version[2] !== "0") throw new Error(`原生组件缺少 macOS 13.0 部署目标：${source}`);
    const binary = readFileSync(source);
    const textOffset = Number(loadCommands.match(/sectname\s+__text\b[\s\S]*?^\s+offset\s+(\d+)/m)?.[1]);
    if (binary.readUInt32LE(0) !== 0xfeedfacf || !Number.isSafeInteger(textOffset) || textOffset - 32 - binary.readUInt32LE(20) < 16) {
      throw new Error(`原生组件缺少签名加载命令空间：${source}`);
    }
  }
  for (const [source, name] of outputs) copyFileSync(source, resolve(distDir, name));
  console.log(`Intel 原生 SDK 已准备完成，最低部署目标 macOS ${minimumMacVersion}。`);
}

if (import.meta.main) await prepareNative();
