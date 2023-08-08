import {NativePath}                   from '@yarnpkg/fslib';
import fs                             from 'fs';
import moduleExports, {isBuiltin}     from 'module';
import {fileURLToPath, pathToFileURL} from 'url';

import {packageImportsResolve}        from '../../node/resolve';
import {PnpApi}                       from '../../types';
import * as loaderUtils               from '../loaderUtils';

if (!moduleExports.findPnpApi) {
  const pnpPath = `./.pn` + `p.cjs`;
  const {default: pnpApi} = await import(pnpPath);
  pnpApi.setup();
}

const isRelativeRegexp = /^\.{0,2}\//;

type ResolveContext = {
  conditions: Array<string>;
  parentURL: string | undefined;
};

function tryReadFile(filePath: string) {
  try {
    return fs.readFileSync(filePath, `utf8`);
  } catch (err) {
    if (err.code === `ENOENT`)
      return undefined;

    throw err;
  }
}

async function resolvePrivateRequest(specifier: string, issuer: string, context: ResolveContext, nextResolve: typeof resolve): Promise<{ url: string, shortCircuit: boolean }> {
  const resolved = packageImportsResolve({
    name: specifier,
    base: pathToFileURL(issuer),
    conditions: new Set(context.conditions),
    readFileSyncFn: tryReadFile,
  });

  if (resolved instanceof URL) {
    return {url: resolved.href, shortCircuit: true};
  } else {
    if (resolved.startsWith(`#`))
      // Node behaves interestingly by default so just block the request for now.
      // https://github.com/nodejs/node/issues/40579
      throw new Error(`Mapping from one private import to another isn't allowed`);

    return resolve(resolved, context, nextResolve);
  }
}

export async function resolve(
  originalSpecifier: string,
  context: ResolveContext,
  nextResolve: typeof resolve,
): Promise<{ url: string, shortCircuit: boolean }> {
  const {findPnpApi} = (moduleExports as unknown) as { findPnpApi?: (path: NativePath) => null | PnpApi };
  if (!findPnpApi || isBuiltin(originalSpecifier))
    return nextResolve(originalSpecifier, context, nextResolve);

  let specifier = originalSpecifier;
  const url = loaderUtils.tryParseURL(specifier, isRelativeRegexp.test(specifier) ? context.parentURL : undefined);
  if (url) {
    if (url.protocol !== `file:`)
      return nextResolve(originalSpecifier, context, nextResolve);

    specifier = fileURLToPath(url);
  }

  const {parentURL, conditions = []} = context;

  const issuer = parentURL && loaderUtils.tryParseURL(parentURL)?.protocol === `file:` ? fileURLToPath(parentURL) : process.cwd();

  // Get the pnpapi of either the issuer or the specifier.
  // The latter is required when the specifier is an absolute path to a
  // zip file and the issuer doesn't belong to a pnpapi
  const pnpapi = findPnpApi(issuer) ?? (url ? findPnpApi(specifier) : null);
  if (!pnpapi)
    return nextResolve(originalSpecifier, context, nextResolve);

  if (specifier.startsWith(`#`))
    return resolvePrivateRequest(specifier, issuer, context, nextResolve);

  let result;
  try {
    result = pnpapi.resolveRequest(specifier, issuer, {
      conditions: new Set(conditions),
      // TODO: Handle --experimental-specifier-resolution=node
      extensions: [`.js`, `.ts`, `.json`],
    });
  } catch (err) {
    if (err instanceof Error && `code` in err && err.code === `MODULE_NOT_FOUND`)
      err.code = `ERR_MODULE_NOT_FOUND`;

    throw err;
  }

  if (!result)
    throw new Error(`Resolving '${specifier}' from '${issuer}' failed`);

  const resultURL = pathToFileURL(result);

  // Node preserves the `search` and `hash` to allow cache busting
  // https://github.com/nodejs/node/blob/85d4cd307957bd35e7c723d0f1d2b77175fd9b0f/lib/internal/modules/esm/resolve.js#L405-L406
  if (url) {
    resultURL.search = url.search;
    resultURL.hash = url.hash;
  }

  if (!parentURL)
    loaderUtils.setEntrypointPath(fileURLToPath(resultURL));

  return {
    url: resultURL.href,
    shortCircuit: true,
  };
}
