import {NativePath}         from '@yarnpkg/fslib';
import fs                   from 'fs';
import path                 from 'path';
import {URL, fileURLToPath} from 'url';

import * as nodeUtils       from '../loader/nodeUtils';

export async function tryReadFile(path: NativePath): Promise<string | null> {
  try {
    return await fs.promises.readFile(path, `utf8`);
  } catch (error) {
    if (error.code === `ENOENT`)
      return null;

    throw error;
  }
}

export function tryParseURL(str: string, base?: string | URL | undefined) {
  try {
    return new URL(str, base);
  } catch {
    return null;
  }
}

let entrypointPath: NativePath | null = null;

export function setEntrypointPath(file: NativePath) {
  entrypointPath = file;
}

export function getFileFormat(filepath: string): string | null {
  const ext = path.extname(filepath);

  switch (ext) {
    case `.mjs`:
    case `.ts`:
    case `.tsx`: {
      return `module`;
    }
    case `.cjs`: {
      return `commonjs`;
    }
    case `.wasm`: {
      // TODO: Enable if --experimental-wasm-modules is present
      // Waiting on https://github.com/nodejs/node/issues/36935
      return 'module';
    }
    case `.json`: {
      // TODO: Enable if --experimental-json-modules is present
      // Waiting on https://github.com/nodejs/node/issues/36935
      return `module`;
    }
    case `.js`: {
      const pkg = nodeUtils.readPackageScope(filepath);
      // assume CJS for files outside of a package boundary
      if (!pkg)
        return `commonjs`;
      return pkg.data.type ?? `commonjs`;
    }
    // Matching files beyond those handled above deviates from Node's default
    // --experimental-loader behavior but is required to work around
    // https://github.com/nodejs/node/issues/33226
    default: {
      if (entrypointPath !== filepath)
        return null;
      const pkg = nodeUtils.readPackageScope(filepath);
      if (!pkg)
        return `commonjs`;
      // prevent extensions beyond .mjs or .js from loading as ESM
      if (pkg.data.type === `module`)
        return null;
      return pkg.data.type ?? `commonjs`;
    }
  }
}

let esbuild: typeof import('esbuild');

export async function readSource(url: URL): Promise<string> {
  const content = await fs.promises.readFile(fileURLToPath(url), `utf8`);

  const ext = path.extname(fileURLToPath(url));
  if (ext === `.ts` || ext === `.tsx`) {
    esbuild ??= process.env.USE_ESBUILD_WASM === `true`
      ? await import(`esbuild-wasm`)
      : await import(`esbuild`);

    return (await esbuild.transform(content, {
      format: `esm`,
      jsxFactory: `h`,
      jsxFragment: `Fragment`,
      loader: ext === `.tsx` ? `tsx` : `ts`,
      target: `esnext`,
    })).code;
  }

  if (ext === `.json`)
    return `const data = ${content};export default data;`;

  return content;
}
