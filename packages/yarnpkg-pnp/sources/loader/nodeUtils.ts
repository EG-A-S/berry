import {NativePath, npath, VirtualFS}   from '@yarnpkg/fslib';
import fs                               from 'fs';
import path                             from 'path';

import {WATCH_MODE_MESSAGE_USES_ARRAYS} from '../esm-loader/loaderFlags';

const packageCache = new Map<string, unknown | false>();

// https://github.com/nodejs/node/blob/e817ba70f56c4bfd5d4a68dce8b165142312e7b6/lib/internal/modules/cjs/loader.js#L315-L330
export function readPackageScopeSync(checkPath: NativePath) {
  const rootSeparatorIndex = checkPath.indexOf(npath.sep);
  let separatorIndex;
  do {
    separatorIndex = checkPath.lastIndexOf(npath.sep);
    checkPath = checkPath.slice(0, separatorIndex);
    if (checkPath.endsWith(`${npath.sep}node_modules`))
      return false;
    const pjson = readPackageSync(checkPath + npath.sep);
    if (pjson) {
      return {
        data: pjson,
        path: checkPath,
      };
    }
  } while (separatorIndex > rootSeparatorIndex);
  return false;
}

// https://github.com/nodejs/node/blob/e817ba70f56c4bfd5d4a68dce8b165142312e7b6/lib/internal/modules/cjs/loader.js#L284-L313
export function readPackageSync(requestPath: NativePath) {
  const jsonPath = npath.resolve(requestPath, `package.json`);

  const cachedPackageData = packageCache.get(jsonPath);
  if (cachedPackageData) return cachedPackageData;
  if (cachedPackageData === false) return null;

  let content: string;
  try {
    content = fs.readFileSync(jsonPath, `utf8`);
  } catch {
    packageCache.set(jsonPath, false);
    return null;
  }

  const packageData = JSON.parse(content);
  packageCache.set(jsonPath, packageData);
  return packageData;
}

export async function readPackageScopeAsync(checkPath: NativePath) {
  const rootSeparatorIndex = checkPath.indexOf(npath.sep);
  let separatorIndex;
  do {
    separatorIndex = checkPath.lastIndexOf(npath.sep);
    checkPath = checkPath.slice(0, separatorIndex);
    if (checkPath.endsWith(`${npath.sep}node_modules`))
      return false;
    const pjson = await readPackageAsync(checkPath + npath.sep);
    if (pjson) {
      return {
        data: pjson,
        path: checkPath,
      };
    }
  } while (separatorIndex > rootSeparatorIndex);
  return false;
}

export async function readPackageAsync(requestPath: NativePath) {
  const jsonPath = npath.resolve(requestPath, `package.json`);

  const cachedPackageData = packageCache.get(jsonPath);
  if (cachedPackageData) return cachedPackageData;
  if (cachedPackageData === false) return null;

  let content: string;
  try {
    content = await fs.promises.readFile(jsonPath, `utf8`);
  } catch {
    packageCache.set(jsonPath, false);
    return null;
  }

  const packageData = JSON.parse(content);
  packageCache.set(jsonPath, packageData);
  return packageData;
}

// https://github.com/nodejs/node/blob/972d9218559877f7fff4bb6086afacac8933f8d1/lib/internal/errors.js#L1450-L1478
// Our error isn't as detailed since we don't have access to acorn to check
// if the file contains ESM syntax
export function ERR_REQUIRE_ESM(filename: string, parentPath: string | null = null) {
  const basename =
    parentPath && path.basename(filename) === path.basename(parentPath)
      ? filename
      : path.basename(filename);

  const msg =
    `require() of ES Module ${filename}${parentPath ? ` from ${parentPath}` : ``} not supported.
Instead change the require of ${basename} in ${parentPath} to a dynamic import() which is available in all CommonJS modules.`;

  const err = new Error(msg) as Error & { code: string };
  err.code = `ERR_REQUIRE_ESM`;
  return err;
}

// https://github.com/nodejs/node/pull/44366
// https://github.com/nodejs/node/pull/45348
export function reportRequiredFilesToWatchMode(files: Array<NativePath>) {
  if (process.env.WATCH_REPORT_DEPENDENCIES && process.send) {
    files = files.map(filename => npath.fromPortablePath(VirtualFS.resolveVirtual(npath.toPortablePath(filename))));
    if (WATCH_MODE_MESSAGE_USES_ARRAYS) {
      process.send({'watch:require': files});
    } else {
      for (const filename of files) {
        process.send({'watch:require': filename});
      }
    }
  }
}
