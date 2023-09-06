import {Hooks as CoreHooks, Plugin, Project, SettingsType, WindowsLinkType} from '@yarnpkg/core';
import {Filename, PortablePath, npath, ppath, xfs}                          from '@yarnpkg/fslib';
import {Hooks as StageHooks}                                                from '@yarnpkg/plugin-stage';
import {pathToFileURL}                                                      from 'url';

import {PnpLinker}                                                          from './PnpLinker';
import UnplugCommand                                                        from './commands/unplug';
import * as jsInstallUtils                                                  from './jsInstallUtils';
import * as pnpUtils                                                        from './pnpUtils';

export {UnplugCommand};
export {jsInstallUtils};
export {pnpUtils};

export const getPnpPath = (project: Project) => {
  return {
    cjs: ppath.join(project.cwd, Filename.pnpCjs),
    data: ppath.join(project.cwd, Filename.pnpData),
    esmLoader: ppath.join(project.cwd, Filename.pnpEsmLoader),
    registerHooks: ppath.join(project.cwd, Filename.registerHooks),
  };
};

export const quotePathIfNeeded = (path: string) => {
  return /\s/.test(path) ? JSON.stringify(path) : path;
};

async function setupScriptEnvironment(project: Project, env: {[key: string]: string}, makePathWrapper: (name: string, argv0: string, args: Array<string>) => Promise<void>) {
  // We still support .pnp.js files to improve multi-project compatibility.
  // TODO: Drop the question mark in the RegExp after .pnp.js files stop being used.
  // TODO: Support `-r` as an alias for `--require` (in all packages)
  const pnpRegularExpression = /\s*--require\s+\S*\.pnp\.c?js\s*/g;
  const esmLoaderExpression = /\s*--experimental-loader\s+\S*\.pnp\.loader\.mjs\s*/;

  const nodeOptions = (env.NODE_OPTIONS ?? ``)
    .replace(pnpRegularExpression, ` `)
    .replace(esmLoaderExpression, ` `)
    .trim();

  // We remove the PnP hook from NODE_OPTIONS because the process can have
  // NODE_OPTIONS set while changing linkers, which affects build scripts.
  if (project.configuration.get(`nodeLinker`) !== `pnp`) {
    env.NODE_OPTIONS = nodeOptions;
    return;
  }

  const pnpPath = getPnpPath(project);
  let pnpRequire = `--require ${quotePathIfNeeded(npath.fromPortablePath(pnpPath.cjs))}`;

  if (xfs.existsSync(pnpPath.registerHooks))
    pnpRequire += ` --import ${pathToFileURL(npath.fromPortablePath(pnpPath.registerHooks)).href}`;
  else if (xfs.existsSync(pnpPath.esmLoader))
    pnpRequire = `${pnpRequire} --loader ${pathToFileURL(npath.fromPortablePath(pnpPath.esmLoader)).href}`;

  if (xfs.existsSync(pnpPath.cjs)) {
    let nodeOptions = env.NODE_OPTIONS || ``;

    // We still support .pnp.js files to improve multi-project compatibility.
    // TODO: Drop the question mark in the RegExp after .pnp.js files stop being used.
    const pnpRegularExpression = /\s*--require\s+\S*\.pnp\.c?js\s*/g;
    const esmLoaderExpression = /\s*--loader\s+\S*\.pnp\.loader\.mjs\s*/;
    const registerHooksExpression = /\s*--import\s+\S*\.register-hooks\.mjs\s*/;
    nodeOptions = nodeOptions.replace(pnpRegularExpression, ` `).replace(esmLoaderExpression, ` `).replace(registerHooksExpression, ` `).trim();

    nodeOptions = nodeOptions ? `${pnpRequire} ${nodeOptions}` : pnpRequire;

    const configuredNodeOptions = project.configuration.get(`nodeOptions`);

    env.NODE_OPTIONS = nodeOptions + (configuredNodeOptions ? ` ${configuredNodeOptions}` : ``);
  }
}

async function populateYarnPaths(project: Project, definePath: (path: PortablePath | null) => void) {
  const pnpPath = getPnpPath(project);
  definePath(pnpPath.cjs);
  definePath(pnpPath.data);
  definePath(pnpPath.esmLoader);

  definePath(project.configuration.get(`pnpUnpluggedFolder`));
}

declare module '@yarnpkg/core' {
  interface ConfigurationValueMap {
    nodeLinker: string;
    nodeOptions: string;
    winLinkType: string;
    pnpMode: string;
    pnpShebang: string;
    pnpIgnorePatterns: Array<string>;
    pnpEnableEsmLoader: boolean;
    pnpEnableInlining: boolean;
    pnpFallbackMode: string;
    pnpUnpluggedFolder: PortablePath;
  }
}

const plugin: Plugin<CoreHooks & StageHooks> = {
  hooks: {
    populateYarnPaths,
    setupScriptEnvironment,
  },
  configuration: {
    nodeLinker: {
      description: `The linker used for installing Node packages, one of: "pnp", "node-modules"`,
      type: SettingsType.STRING,
      default: `pnp`,
    },
    nodeOptions: {
      description: `Node options to use when setting up the script environment`,
      type: SettingsType.STRING,
      default: ``,
    },
    winLinkType: {
      description: `Whether Yarn should use Windows Junctions or symlinks when creating links on Windows.`,
      type: SettingsType.STRING,
      values: [
        WindowsLinkType.JUNCTIONS,
        WindowsLinkType.SYMLINKS,
      ],
      default: WindowsLinkType.JUNCTIONS,
    },
    pnpMode: {
      description: `If 'strict', generates standard PnP maps. If 'loose', merges them with the n_m resolution.`,
      type: SettingsType.STRING,
      default: `strict`,
    },
    pnpShebang: {
      description: `String to prepend to the generated PnP script`,
      type: SettingsType.STRING,
      default: `#!/usr/bin/env node`,
    },
    pnpIgnorePatterns: {
      description: `Array of glob patterns; files matching them will use the classic resolution`,
      type: SettingsType.STRING,
      default: [],
      isArray: true,
    },
    pnpEnableEsmLoader: {
      description: `If true, Yarn will generate an ESM loader (\`.pnp.loader.mjs\`). If this is not explicitly set Yarn tries to automatically detect whether ESM support is required.`,
      type: SettingsType.BOOLEAN,
      default: false,
    },
    pnpEnableInlining: {
      description: `If true, the PnP data will be inlined along with the generated loader`,
      type: SettingsType.BOOLEAN,
      default: true,
    },
    pnpFallbackMode: {
      description: `If true, the generated PnP loader will follow the top-level fallback rule`,
      type: SettingsType.STRING,
      default: `dependencies-only`,
    },
    pnpUnpluggedFolder: {
      description: `Folder where the unplugged packages must be stored`,
      type: SettingsType.ABSOLUTE_PATH,
      default: `./.yarn/unplugged`,
    },
  },
  linkers: [
    PnpLinker,
  ],
  commands: [
    UnplugCommand,
  ],
};

export {PnpInstaller, PnpLinker} from './PnpLinker';

// eslint-disable-next-line arca/no-default-export
export default plugin;
