import {PortablePath}                      from '@yarnpkg/fslib';
import {parse, init}                       from 'cjs-module-lexer';
import fs                                  from 'fs';
import * as moduleExports                  from 'module';
import path                                from 'path';
import {fileURLToPath, pathToFileURL, URL} from 'url';

import {PnpApi}                            from '../types';

function isValidURL(str: string) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

const builtins = new Set([...moduleExports.builtinModules]);

// @ts-expect-error - This module, when bundled, is still ESM so this is valid
const pnpapi: PnpApi = moduleExports.createRequire(import.meta.url)(`pnpapi`);

const pathRegExp = /^(?![a-zA-Z]:[\\/]|\\\\|\.{0,2}(?:\/|$))((?:node:)?(?:@[^/]+\/)?[^/]+)\/*(.*|)$/;

async function exists(path: string) {
  try {
    await fs.promises.access(path, fs.constants.R_OK);
    return true;
  } catch { }
  return false;
}

export async function resolve(
  specifier: string,
  context: any,
  defaultResolver: any
) {
  let validURL;
  if (builtins.has(specifier) || (validURL = isValidURL(specifier))) {
    if (!validURL || pathToFileURL(specifier).protocol !== `file:` || specifier.startsWith(`node:`)) {
      return defaultResolver(specifier, context, defaultResolver);
    } else {
      try {
        specifier = fileURLToPath(specifier);
      } catch {
        specifier = fileURLToPath(pathToFileURL(specifier).href);
      }
    }
  }

  const {parentURL, conditions = []} = context;

  const parentPath = parentURL ? fileURLToPath(parentURL) : process.cwd();

  const dependencyNameMatch = specifier.match(pathRegExp);

  let allowLegacyResolve = false;

  if (dependencyNameMatch) {
    const [, dependencyName, subPath] = dependencyNameMatch as [unknown, string, PortablePath];

    // https://github.com/nodejs/node/blob/0996eb71edbd47d9f9ec6153331255993fd6f0d1/lib/internal/modules/esm/resolve.js#L686-L691
    if (subPath === ``) {
      const resolved = pnpapi.resolveToUnqualified(`${dependencyName}/package.json`, parentPath);
      if (resolved && await exists(resolved)) {
        const pkg = JSON.parse(await fs.promises.readFile(resolved, `utf8`));
        allowLegacyResolve = pkg.exports == null;
      }
    }
  }

  let query;

  if (specifier.includes('?')) {
    [specifier, query] = specifier.split('?');
  }

  const result = pnpapi.resolveRequest(specifier, parentPath, {
    conditions: new Set(conditions),
    // TODO: Handle --experimental-specifier-resolution=node
    extensions: [`.js`, `.ts`, `.tsx`, `.cjs`, `.mjs`, `.json`],
  });

  if (!result)
    throw new Error(`Resolution failed`);

  return {
    url: pathToFileURL(query ? `${result}?${query}` : result).href,
  };
}

const realModules = new Set<string>();

export async function getFormat(
  resolved: string,
  context: any,
  defaultGetFormat: any
) {
  const parsedURL = new URL(resolved);
  if (parsedURL.protocol !== `file:`)
    return defaultGetFormat(resolved, context, defaultGetFormat);

  switch (path.extname(parsedURL.pathname)) {
    case `.mjs`: {
      realModules.add(fileURLToPath(resolved));
      return {
        format: `module`,
      };
    }
    case `.cjs`: {
      return {
        format: `module`,
      };
    }
    case `.json`: {
      return {
        format: `module`,
      };
    }
    default: {
      let packageJSONUrl = new URL(`./package.json`, resolved);
      while (true) {
        if (packageJSONUrl.pathname.endsWith(`node_modules/package.json`))
          break;

        const filePath = fileURLToPath(packageJSONUrl);

        try {
          let moduleType =
            JSON.parse(await fs.promises.readFile(filePath, `utf8`)).type ??
            `commonjs`;
          if (moduleType === `commonjs`) moduleType = `module`;
          else realModules.add(fileURLToPath(resolved));

          return {
            format: moduleType,
          };
        } catch {}

        const lastPackageJSONUrl = packageJSONUrl;
        packageJSONUrl = new URL(`../package.json`, packageJSONUrl);

        if (packageJSONUrl.pathname === lastPackageJSONUrl.pathname) {
          break;
        }
      }
    }
  }

  throw new Error(`Unable to get module type of '${resolved}'`);
}

let parserInit: Promise<void> | null = init().then(() => {
  parserInit = null;
});

async function parseExports(filePath: string) {
  const {exports} = parse(await fs.promises.readFile(filePath, `utf8`));

  return new Set(exports);
}

export async function getSource(
  urlString: string,
  context: any,
  defaultGetSource: any
) {
  const url = new URL(urlString);
  if (url.protocol !== `file:`)
    return defaultGetSource(url, context, defaultGetSource);

  if (urlString.includes('%3F')) {
    [urlString] = urlString.split('%3F');
  }

  urlString = fileURLToPath(urlString);

  const ext = path.extname(urlString);
  if (ext === `.ts` || ext === `.tsx`) {
    const { transform } = await import(`esbuild`);

    const source = (await transform(await fs.promises.readFile(urlString, `utf8`), {
        format: `esm`,
        jsxFactory: `h`,
        jsxFragment: `Fragment`,
        loader: ext === `.tsx` ? `tsx` : `ts`,
        target: `esnext`
    })).code;

    return { source };
  }

  if (realModules.has(urlString)) {
    return {
      source: await fs.promises.readFile(urlString, `utf8`),
    };
  }

  if (parserInit !== null) await parserInit;

  const exports = await parseExports(urlString);

  // Hacky workaround for @typescript-eslint
  if (exports.has('TSESLintScope')) {
    exports.add('AST_NODE_TYPES');
    exports.add('AST_TOKEN_TYPES');
  }

  // Hacky workaround for @babel/core
  if (exports.has('transformFromAstAsync')) {
    exports.add('types');
  }

  let exportStrings = `export default cjs\n`;
  for (const exportName of exports) {
    if (exportName !== `default`) {
      exportStrings += `const __${exportName} = cjs['${exportName}'];\n export { __${exportName} as ${exportName} }\n`;
    }
  }

  const fakeModulePath = path.join(path.dirname(urlString), `noop.js`);

  const code = `
  import {createRequire} from 'module';
  const require = createRequire('${fakeModulePath.replace(/\\/g, `/`)}');
  const cjs = require('${urlString.replace(/\\/g, `/`)}');

  ${exportStrings}
  `;

  return {
    source: code,
  };
}
