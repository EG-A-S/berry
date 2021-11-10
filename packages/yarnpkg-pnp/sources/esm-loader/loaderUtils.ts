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

export function tryParseURL(str: string) {
  if (str.includes(`%3F`))
    [str] = str.split(`%3F`);

  try {
    return new URL(str);
  } catch {
    return null;
  }
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
      throw new Error(
        `Unknown file extension ".wasm" for ${filepath}`,
      );
    }
    case `.json`: {
      // TODO: Enable if --experimental-json-modules is present
      // Waiting on https://github.com/nodejs/node/issues/36935
      return `module`;
    }
    // Matching files without extensions deviates from Node's default
    // behaviour but is a fix for https://github.com/nodejs/node/issues/33226
    case ``:
    case `.js`: {
      const pkg = nodeUtils.readPackageScope(filepath);
      if (pkg) {
        return pkg.data.type ?? `commonjs`;
      }
    }
  }

  return null;
}

let esbuild: typeof import('esbuild');

export async function readSource(url: URL): Promise<string> {
  const content = await fs.promises.readFile(fileURLToPath(url), `utf8`);

  const ext = path.extname(fileURLToPath(url));
  if (ext === `.ts` || ext === `.tsx`) {
    const {transform} = esbuild ??= await import(`esbuild`);

    return (await transform(content, {
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
