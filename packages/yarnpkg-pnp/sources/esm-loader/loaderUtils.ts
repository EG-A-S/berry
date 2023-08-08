import {NativePath}   from '@yarnpkg/fslib';
import fs             from 'fs';
import path           from 'path';
import {URL}          from 'url';

import * as nodeUtils from '../loader/nodeUtils';

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
  return URL.canParse(str, base) ? new URL(str, base) : null;
}

let entrypointPath: NativePath | null = null;

export function setEntrypointPath(file: NativePath) {
  entrypointPath = file;
}

export async function getFileFormat(filepath: string): Promise<string | null> {
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
      return `module`;
    }
    case `.json`: {
      return `json`;
    }
    case `.js`: {
      const pkg = await nodeUtils.readPackageScopeAsync(filepath);
      // assume CJS for files outside of a package boundary
      if (!pkg)
        return `commonjs`;
      return pkg.data.module ? `module` : pkg.data.type ?? `commonjs`;
    }
    // Matching files beyond those handled above deviates from Node's default
    // --experimental-loader behavior but is required to work around
    // https://github.com/nodejs/node/issues/33226
    default: {
      if (entrypointPath !== filepath)
        return null;
      const pkg = await nodeUtils.readPackageScopeAsync(filepath);
      if (!pkg)
        return `commonjs`;
      // prevent extensions beyond .mjs or .js from loading as ESM
      if (pkg.data.type === `module`)
        return null;
      return pkg.data.type ?? `commonjs`;
    }
  }
}
