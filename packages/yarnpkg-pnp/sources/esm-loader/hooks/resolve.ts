import {NativePath, PortablePath}     from '@yarnpkg/fslib';
import moduleExports                  from 'module';
import path                           from 'path';
import {fileURLToPath, pathToFileURL} from 'url';

import * as nodeUtils                 from '../../loader/nodeUtils';
import {PnpApi}                       from '../../types';
import * as loaderUtils               from '../loaderUtils';

const pathRegExp = /^(?![a-zA-Z]:[\\/]|\\\\|\.{0,2}(?:\/|$))((?:node:)?(?:@[^/]+\/)?[^/]+)\/*(.*|)$/;
const isRelativeRegexp = /^\.{0,2}\//;

export async function resolve(
  originalSpecifier: string,
  context: { conditions: Array<string>, parentURL: string | undefined },
  defaultResolver: typeof resolve,
): Promise<{ url: string }> {
  const {findPnpApi} = (moduleExports as unknown) as { findPnpApi?: (path: NativePath) => null | PnpApi };
  if (!findPnpApi || nodeUtils.isBuiltinModule(originalSpecifier))
    return defaultResolver(originalSpecifier, context, defaultResolver);

  let specifier = originalSpecifier;
  const url = loaderUtils.tryParseURL(specifier, isRelativeRegexp.test(specifier) ? context.parentURL : undefined);
  if (url) {
    if (url.protocol !== `file:`)
      return defaultResolver(originalSpecifier, context, defaultResolver);

    specifier = fileURLToPath(url);
  }

  const {parentURL, conditions = []} = context;

  const issuer = parentURL ? fileURLToPath(parentURL) : process.cwd();

  // Get the pnpapi of either the issuer or the specifier.
  // The latter is required when the specifier is an absolute path to a
  // zip file and the issuer doesn't belong to a pnpapi
  const pnpapi = findPnpApi(issuer) ?? (url ? findPnpApi(specifier) : null);
  if (!pnpapi)
    return defaultResolver(originalSpecifier, context, defaultResolver);

  if (specifier.startsWith('#')) {
    const issuerLocator = pnpapi.findPackageLocator(issuer);
    const resolved = issuerLocator
      ? pnpapi.resolveToUnqualified(`${issuerLocator.name}/package.json`, issuer)
      : null;

    if (resolved) {
      const content = await loaderUtils.tryReadFile(resolved);

      if (content) {
        const pkg = JSON.parse(content);

        if (typeof pkg.imports[specifier] === 'string') {
          specifier = path.join(path.dirname(resolved), pkg.imports[specifier]);
        }
      }
    }
  }

  let result;

  try {
    result = pnpapi.resolveRequest(specifier, issuer, {
      conditions: new Set(conditions),
      // TODO: Handle --experimental-specifier-resolution=node
      extensions: [`.js`, `.ts`, `.tsx`, `.cjs`, `.mjs`, `.json`],
    });
  } catch (error) {
    const issuerExt = path.extname(issuer);
    const specifierExt = path.extname(specifier);

    const doResolveWithTypeScriptCompatLayer =
      (issuerExt === `.ts` || issuerExt === `.tsx`) &&
      (specifierExt === `.js` || specifierExt === `.jsx`);

    if (!doResolveWithTypeScriptCompatLayer)
      throw error;

    const compatSpecifier = specifier.replace(/\.j(sx?)$/, '.t$1');

    result = pnpapi.resolveRequest(compatSpecifier, issuer, {
      conditions: new Set(conditions),
      // TODO: Handle --experimental-specifier-resolution=node
      extensions: [],
    });
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
  };
}
