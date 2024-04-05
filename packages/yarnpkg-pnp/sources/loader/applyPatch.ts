import {FakeFS, PosixFS, npath, patchFs, PortablePath, NativePath, VirtualFS} from '@yarnpkg/fslib';
import fs                                                                     from 'fs';
import {Module, createRequire, isBuiltin}                                     from 'module';
import os                                                                     from 'os';
import path                                                                   from 'path';
import {URL, fileURLToPath, pathToFileURL}                                    from 'url';

import {PnpApi}                                                               from '../types';

import {ErrorCode, makeError, getIssuerModule}                                from './internalTools';
import {Manager}                                                              from './makeManager';
import * as nodeUtils                                                         from './nodeUtils';

const hiddenRequire = createRequire(pathToFileURL(__filename));

export type ApplyPatchOptions = {
  fakeFs: FakeFS<PortablePath>;
  manager: Manager;
};

declare global {
  module NodeJS {
    interface Process {
      dlopen: (module: Object, filename: string, flags?: number) => void;
    }
  }
}

export function applyPatch(pnpapi: PnpApi, opts: ApplyPatchOptions) {
  /**
   * Used to disable the resolution hooks (for when we want to fallback to the previous resolution - we then need
   * a way to "reset" the environment temporarily)
   */

  let enableNativeHooks = true;

  process.versions.pnp = String(pnpapi.VERSIONS.std);

  const moduleExports = require(`module`);

  moduleExports.findPnpApi = (lookupSource: URL | NativePath) => {
    const lookupPath = lookupSource instanceof URL
      ? fileURLToPath(lookupSource)
      : lookupSource;

    const apiPath = opts.manager.findApiPathFor(lookupPath);
    if (apiPath === null)
      return null;

    const apiEntry = opts.manager.getApiEntry(apiPath, true);
    // Check if the path is ignored
    return apiEntry.instance.findPackageLocator(lookupPath) ? apiEntry.instance : null;
  };

  function getRequireStack(parent: NodeModule | null | undefined) {
    const requireStack = [];

    for (let cursor = parent; cursor; cursor = cursor.parent)
      requireStack.push(cursor.filename || cursor.id);

    return requireStack;
  }

  const originalModuleLoad = Module._load;
  Module._load = function(request: string, parent: NodeModule | null | undefined, isMain: boolean) {
    // The 'pnpapi' name is reserved to return the PnP api currently in use by the program
    if (request === `pnpapi`) {
      const parentApiPath = opts.manager.getApiPathFromParent(parent);

      if (parentApiPath) {
        return opts.manager.getApiEntry(parentApiPath, true).instance;
      }
    }

    return originalModuleLoad.call(Module, request, parent, isMain);
  };

  type IssuerSpec = {
    apiPath: PortablePath | null;
    path: NativePath | null;
    module: NodeModule | null | undefined;
  };

  function getIssuerSpecsFromPaths(paths: Array<NativePath>): Array<IssuerSpec> {
    return paths.map(path => ({
      apiPath: opts.manager.findApiPathFor(path),
      path,
      module: null,
    }));
  }

  function getIssuerSpecsFromModule(module: NodeModule | null | undefined): Array<IssuerSpec> {
    if (module && module.id !== `<repl>` && module.id !== `internal/preload` && !module.parent && !module.filename && module.paths.length > 0) {
      return [{
        apiPath: opts.manager.findApiPathFor(module.paths[0]),
        path: module.paths[0],
        module,
      }];
    }

    const issuer = getIssuerModule(module);

    if (issuer !== null) {
      const path = npath.dirname(issuer.filename);
      const apiPath = opts.manager.getApiPathFromParent(issuer);

      return [{apiPath, path, module}];
    } else {
      const path = process.cwd();

      const apiPath =
        opts.manager.findApiPathFor(npath.join(path, `[file]`)) ??
        opts.manager.getApiPathFromParent(null);

      return [{apiPath, path, module}];
    }
  }

  function makeFakeParent(path: string) {
    const fakeParent = new Module(``);

    const fakeFilePath = npath.join(path, `[file]`);
    fakeParent.paths = Module._nodeModulePaths(fakeFilePath);

    return fakeParent;
  }

  // Splits a require request into its components, or return null if the request is a file path
  const pathRegExp = /^(?![a-zA-Z]:[\\/]|\\\\|\.{0,2}(?:\/|$))((?:@[^/]+\/)?[^/]+)\/*(.*|)$/;

  const originalModuleResolveFilename = Module._resolveFilename;

  Module._resolveFilename = function(request: string, parent: (NodeModule & {pnpApiPath?: PortablePath}) | null | undefined, isMain: boolean, options?: {[key: string]: any}) {
    if (isBuiltin(request))
      return request;

    if (!enableNativeHooks)
      return originalModuleResolveFilename.call(Module, request, parent, isMain, options);

    if (options && options.plugnplay === false) {
      const {plugnplay, ...forwardedOptions} = options;

      try {
        enableNativeHooks = false;
        return originalModuleResolveFilename.call(Module, request, parent, isMain, forwardedOptions);
      } finally {
        enableNativeHooks = true;
      }
    }

    // We check that all the options present here are supported; better
    // to fail fast than to introduce subtle bugs in the runtime.

    if (options) {
      const optionNames = new Set(Object.keys(options));
      optionNames.delete(`paths`);
      optionNames.delete(`plugnplay`);

      if (optionNames.size > 0) {
        throw makeError(
          ErrorCode.UNSUPPORTED,
          `Some options passed to require() aren't supported by PnP yet (${Array.from(optionNames).join(`, `)})`,
        );
      }
    }

    const issuerSpecs = options && options.paths
      ? getIssuerSpecsFromPaths(options.paths)
      : getIssuerSpecsFromModule(parent);

    if (request.match(pathRegExp) === null) {
      const parentDirectory = parent?.filename != null
        ? npath.dirname(parent.filename)
        : null;

      const absoluteRequest = npath.isAbsolute(request)
        ? request
        : parentDirectory !== null
          ? npath.resolve(parentDirectory, request)
          : null;

      if (absoluteRequest !== null) {
        const apiPath = parent && parentDirectory === npath.dirname(absoluteRequest)
          ? opts.manager.getApiPathFromParent(parent)
          : opts.manager.findApiPathFor(absoluteRequest);

        if (apiPath !== null) {
          issuerSpecs.unshift({
            apiPath,
            path: parentDirectory,
            module: null,
          });
        }
      }
    }

    let firstError;

    for (const {apiPath, path, module} of issuerSpecs) {
      let resolution;

      const issuerApi = apiPath !== null
        ? opts.manager.getApiEntry(apiPath, true).instance
        : null;

      try {
        if (issuerApi !== null) {
          resolution = issuerApi.resolveRequest(request, path !== null ? `${path}/` : null);
        } else {
          if (path === null)
            throw new Error(`Assertion failed: Expected the path to be set`);

          resolution = originalModuleResolveFilename.call(Module, request, module || makeFakeParent(path), isMain);
        }
      } catch (error) {
        firstError = firstError || error;
        continue;
      }

      if (resolution !== null) {
        return resolution;
      }
    }

    const requireStack = getRequireStack(parent);

    Object.defineProperty(firstError, `requireStack`, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: requireStack,
    });

    if (requireStack.length > 0)
      firstError.message += `\nRequire stack:\n- ${requireStack.join(`\n- `)}`;

    if (typeof firstError.pnpCode === `string`)
      Error.captureStackTrace(firstError);

    throw firstError;
  };

  const originalFindPath = Module._findPath;

  Module._findPath = function(request: string, paths: Array<string> | null | undefined, isMain: boolean) {
    if (request === `pnpapi`)
      return false;

    if (!enableNativeHooks)
      return originalFindPath.call(Module, request, paths, isMain);

    // https://github.com/nodejs/node/blob/e817ba70f56c4bfd5d4a68dce8b165142312e7b6/lib/internal/modules/cjs/loader.js#L490-L494
    const isAbsolute = npath.isAbsolute(request);
    if (isAbsolute)
      paths = [``];
    else if (!paths || paths.length === 0)
      return false;

    for (const path of paths) {
      let resolution: string | false;

      try {
        const pnpApiPath = opts.manager.findApiPathFor(isAbsolute ? request : path);
        if (pnpApiPath !== null) {
          const api = opts.manager.getApiEntry(pnpApiPath, true).instance;
          resolution = api.resolveRequest(request, path) || false;
        } else {
          resolution = originalFindPath.call(Module, request, [path], isMain);
        }
      } catch (error) {
        continue;
      }

      if (resolution) {
        return resolution;
      }
    }

    return false;
  };

  let transpile: (module: NodeModule, filename: string) => void;

  // https://github.com/nodejs/node/blob/3743406b0a44e13de491c8590386a964dbe327bb/lib/internal/modules/cjs/loader.js#L1110-L1154
  const originalExtensionJSFunction = Module._extensions[`.js`] as (module: NodeModule, filename: string) => void;
  Module._extensions[`.js`] = function (module: NodeModule, filename: string) {
    if (filename.endsWith(`.js`)) {
      const pkg = nodeUtils.readPackageScope(filename);
      if (pkg && pkg.data.type === `module`) {
        transpile(module, filename);
        return;
      }
    }

    if (filename.endsWith(`.wasm`))
      filename += `.js`;

    originalExtensionJSFunction.call(this, module, filename);
  };

  Module._extensions[`.mjs`] = Module._extensions[`.ts`] = Module._extensions[`.tsx`] =
    function (module: NodeModule, filename: string) {
      transpile(module, filename);
    };

  const originalDlopen = process.dlopen;
  process.dlopen = function (...args) {
    const [module, filename, ...rest] = args;
    const filePath = npath.fromPortablePath(VirtualFS.resolveVirtual(npath.toPortablePath(filename)));
    let binaryPath = filePath;
    if (/\.zip[/\\]/.test(filePath)) {
      const tmpDir = path.join(os.tmpdir(), `yarn-unplugged`);
      const fileName = /[/\\]([^/\\]+)[/\\]node_modules/.exec(filePath)?.[1];
      binaryPath = path.join(tmpDir, `${fileName}-${path.basename(filePath)}`);
      const stats = fs.statSync(binaryPath, {throwIfNoEntry: false});
      if (!stats?.isFile()) {
        try {
          fs.mkdirSync(tmpDir);
        } catch {}

        fs.copyFileSync(filePath, binaryPath);
      }
    }
    return originalDlopen.call(
      this,
      module,
      binaryPath,
      ...rest,
    );
  };

  transpile = process.env.ESBUILD_TRANSPILER === `true`
    ? esbuildTranspile
    : swcTranspile;

  if (typeof process.env.VSCODE_PID !== `undefined`)
    process.env.ESBUILD_WORKER_THREADS = `0`;

  let esbuild;

  function esbuildTranspile(module: NodeModule, filename: string) {
    esbuild ??= process.env.USE_WASM_TRANSPILER === `true`
      ? hiddenRequire(`esbuild-wasm`)
      : hiddenRequire(`esbuild`);

    const source = fs.readFileSync(filename, {encoding: `utf8`});

    const importMetaURL = JSON.stringify(pathToFileURL(filename).href);

    const {code} = esbuild.transformSync(source, {
      sourcefile: filename,
      loader: `default`,
      format: `cjs`,
      target: `esnext`,
      jsx: `automatic`,
      jsxDev: process.env.NODE_ENV === `development`,
      jsxImportSource: `preact`,
      define: {
        'import.meta.url': importMetaURL,
      },
    });

    module._compile(code, filename);

    if ((`default` in module.exports)) {
      const defaultExports = module.exports.default;
      const originalModuleExports = module.exports;
      module.exports = typeof defaultExports === `string` ? {} : defaultExports;

      if (/[/\\]node_modules[/\\](?:chalk|clean-stack)[/\\]/.test(filename)) {
        Object.defineProperty(module.exports, `default`, {value: defaultExports});
      } else if (path.extname(filename) === `.js`) {
        for (const key in originalModuleExports) {
          module.exports[key] = originalModuleExports[key];
        }
      }
    }
  }

  let swc;

  function swcTranspile(module: NodeModule, filename: string) {
    swc ??= process.env.USE_WASM_TRANSPILER === `true`
      ? hiddenRequire(`@swc/wasm`)
      : hiddenRequire(`@swc/core`);

    const extname = path.extname(filename);

    const source = fs.readFileSync(filename, {encoding: `utf8`});

    const {code} = swc.transformSync(source, {
      filename,
      configFile: false,
      swcrc: false,
      inputSourceMap: false,
      sourceMaps: false,
      inlineSourcesContent: false,
      isModule: true,
      env: {
        targets: {
          node: process.versions.node,
        },
      },
      jsc: {
        parser: {
          syntax: extname.startsWith(`.ts`) ? `typescript` : `ecmascript`,
          tsx: extname === `.tsx`,
          dynamicImport: true,
          importMeta: true,
        },
        transform: {
          react: {
            importSource: `preact`,
            runtime: `automatic`,
            pragma: `h`,
            pragmaFrag: `Fragment`,
          },
        },
        experimental: {
          keepImportAttributes: true,
          emitAssertForImportAttributes: true,
        },
      },
      module: {
        type: `commonjs`,
      },
    });

    module._compile(code, filename);

    if ((`default` in module.exports)) {
      const defaultExports = module.exports.default;
      const originalModuleExports = module.exports;
      module.exports = typeof defaultExports === `string` ? {} : defaultExports;

      if (/[/\\]node_modules[/\\](?:chalk|clean-stack)[/\\]/.test(filename)) {
        Object.defineProperty(module.exports, `default`, {value: defaultExports});
      } else if (path.extname(filename) === `.js`) {
        for (const key in originalModuleExports) {
          module.exports[key] = originalModuleExports[key];
        }
      }
    }
  }

  // When using the ESM loader Node.js prints either of the following warnings
  //
  // - ExperimentalWarning: --experimental-loader is an experimental feature. This feature could change at any time
  // - ExperimentalWarning: Custom ESM Loaders is an experimental feature. This feature could change at any time
  //
  // Having this warning show up once is "fine" but it's also printed
  // for each Worker that is created so it ends up spamming stderr.
  // Since that doesn't provide any value we suppress the warning.
  const originalEmit = process.emit;
  // @ts-expect-error - TS complains about the return type of originalEmit.apply
  process.emit = function (name, data: any, ...args) {
    if (
      name === `warning` &&
      typeof data === `object` &&
      data.name === `ExperimentalWarning`
    )
      return false;

    return originalEmit.apply(process, arguments as unknown as Parameters<typeof process.emit>);
  };

  patchFs(fs, new PosixFS(opts.fakeFs));
}
