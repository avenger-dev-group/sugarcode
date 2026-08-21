import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { spawn } from 'node:child_process';
import path from 'node:path';

const appIconBasePath = path.join(__dirname, 'assets', 'icon');
const appIconPngPath = `${appIconBasePath}.png`;
const workspaceRoot = path.resolve(__dirname, '..', '..');
const bundledFfmpegDirectory = path.join(__dirname, 'vendor', 'ffmpeg');

const buildReleaseNative = async (
  platform: string,
  arch: string,
): Promise<void> => {
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      `Native Desktop packaging must run on its target host; requested ${platform}/${arch}, current host is ${process.platform}/${process.arch}.`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(workspaceRoot, 'scripts', 'build-desktop-native.mjs'), '--release'],
      { cwd: workspaceRoot, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `Release native build terminated by ${signal}.`
            : `Release native build exited with code ${code ?? 'unknown'}.`,
        ),
      );
    });
  });
};

const buildBundledFfmpeg = async (
  platform: string,
  arch: string,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(workspaceRoot, 'scripts', 'prepare-bundled-ffmpeg.mjs'),
        '--platform',
        platform,
        '--arch',
        arch,
      ],
      { cwd: workspaceRoot, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `Bundled FFmpeg build terminated by ${signal}.`
            : `Bundled FFmpeg build exited with code ${code ?? 'unknown'}.`,
        ),
      );
    });
  });
};

const prepareWindowsMaker = async (): Promise<void> => {
  if (process.platform !== 'win32') {
    return;
  }

  const installerDirectory = path.join(
    workspaceRoot,
    'node_modules',
    'electron-winstaller',
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(installerDirectory, 'script', 'select-7z-arch.js')],
      { cwd: installerDirectory, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `Windows maker preparation terminated by ${signal}.`
            : `Windows maker preparation exited with code ${code ?? 'unknown'}.`,
        ),
      );
    });
  });
};

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: 'com.simonf.sugarcode',
    asar: true,
    extraResource: [
      appIconPngPath,
      path.join(__dirname, 'native', 'sugarcode-desktop-native.node'),
      bundledFfmpegDirectory,
      path.resolve(__dirname, '..', '..', 'THIRD_PARTY_NOTICES.txt'),
    ],
    icon: appIconBasePath,
    osxSign:
      process.platform === 'darwin'
        ? {
            identity: '-',
            identityValidation: false,
            optionsForFile: () => ({
              hardenedRuntime: false,
              timestamp: 'none',
            }),
            preAutoEntitlements: false,
            preEmbedProvisioningProfile: false,
          }
        : undefined,
  },
  rebuildConfig: {},
  hooks: {
    prePackage: async (_forgeConfig, platform, arch) => {
      await buildReleaseNative(platform, arch);
      await buildBundledFfmpeg(platform, arch);
    },
    preMake: async () => {
      await prepareWindowsMaker();
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'SugarCode',
        setupIcon: `${appIconBasePath}.ico`,
      },
    },
    {
      name: '@electron-forge/maker-zip',
      config: {},
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
        icon: `${appIconBasePath}.icns`,
        // appdmg's legacy HFS+ flow runs `bless --openfolder` on Intel Macs.
        // Recent headless macOS runners can auto-eject the volume there, making
        // appdmg's following `hdiutil detach` fail even though it is unmounted.
        additionalDMGOptions: {
          filesystem: 'APFS',
        },
      },
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        icon: appIconPngPath,
      },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        icon: appIconPngPath,
      },
    },
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/runtime/entry.ts',
          config: 'vite.runtime.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
