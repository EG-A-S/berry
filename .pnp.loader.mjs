import { URL, fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';
import moduleExports from 'module';

var PathType;
(function(PathType2) {
  PathType2[PathType2["File"] = 0] = "File";
  PathType2[PathType2["Portable"] = 1] = "Portable";
  PathType2[PathType2["Native"] = 2] = "Native";
})(PathType || (PathType = {}));
const npath = Object.create(path);
const ppath = Object.create(path.posix);
npath.cwd = () => process.cwd();
ppath.cwd = () => toPortablePath(process.cwd());
ppath.resolve = (...segments) => {
  if (segments.length > 0 && ppath.isAbsolute(segments[0])) {
    return path.posix.resolve(...segments);
  } else {
    return path.posix.resolve(ppath.cwd(), ...segments);
  }
};
const contains = function(pathUtils, from, to) {
  from = pathUtils.normalize(from);
  to = pathUtils.normalize(to);
  if (from === to)
    return `.`;
  if (!from.endsWith(pathUtils.sep))
    from = from + pathUtils.sep;
  if (to.startsWith(from)) {
    return to.slice(from.length);
  } else {
    return null;
  }
};
npath.fromPortablePath = fromPortablePath;
npath.toPortablePath = toPortablePath;
npath.contains = (from, to) => contains(npath, from, to);
ppath.contains = (from, to) => contains(ppath, from, to);
const WINDOWS_PATH_REGEXP = /^([a-zA-Z]:.*)$/;
const UNC_WINDOWS_PATH_REGEXP = /^\\\\(\.\\)?(.*)$/;
const PORTABLE_PATH_REGEXP = /^\/([a-zA-Z]:.*)$/;
const UNC_PORTABLE_PATH_REGEXP = /^\/unc\/(\.dot\/)?(.*)$/;
function fromPortablePath(p) {
  if (process.platform !== `win32`)
    return p;
  let portablePathMatch, uncPortablePathMatch;
  if (portablePathMatch = p.match(PORTABLE_PATH_REGEXP))
    p = portablePathMatch[1];
  else if (uncPortablePathMatch = p.match(UNC_PORTABLE_PATH_REGEXP))
    p = `\\\\${uncPortablePathMatch[1] ? `.\\` : ``}${uncPortablePathMatch[2]}`;
  else
    return p;
  return p.replace(/\//g, `\\`);
}
function toPortablePath(p) {
  if (process.platform !== `win32`)
    return p;
  let windowsPathMatch, uncWindowsPathMatch;
  if (windowsPathMatch = p.match(WINDOWS_PATH_REGEXP))
    p = `/${windowsPathMatch[1]}`;
  else if (uncWindowsPathMatch = p.match(UNC_WINDOWS_PATH_REGEXP))
    p = `/unc/${uncWindowsPathMatch[1] ? `.dot/` : ``}${uncWindowsPathMatch[2]}`;
  return p.replace(/\\/g, `/`);
}

function readPackageScope(checkPath) {
  const rootSeparatorIndex = checkPath.indexOf(npath.sep);
  let separatorIndex;
  do {
    separatorIndex = checkPath.lastIndexOf(npath.sep);
    checkPath = checkPath.slice(0, separatorIndex);
    if (checkPath.endsWith(`${npath.sep}node_modules`))
      return false;
    const pjson = readPackage(checkPath + npath.sep);
    if (pjson) {
      return {
        data: pjson,
        path: checkPath
      };
    }
  } while (separatorIndex > rootSeparatorIndex);
  return false;
}
function readPackage(requestPath) {
  const jsonPath = npath.resolve(requestPath, `package.json`);
  if (!fs.existsSync(jsonPath))
    return null;
  return JSON.parse(fs.readFileSync(jsonPath, `utf8`));
}

async function tryReadFile(path2) {
  try {
    return await fs.promises.readFile(path2, `utf8`);
  } catch (error) {
    if (error.code === `ENOENT`)
      return null;
    throw error;
  }
}
function tryParseURL(str) {
  if (str.includes(`%3F`))
    [str] = str.split(`%3F`);
  try {
    return new URL(str);
  } catch {
    return null;
  }
}
function getFileFormat(filepath) {
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
      throw new Error(`Unknown file extension ".wasm" for ${filepath}`);
    }
    case `.json`: {
      return `module`;
    }
    case `.js`:
    case ``: {
      const pkg = readPackageScope(filepath);
      if (pkg) {
        return pkg.data.type ?? `commonjs`;
      }
    }
  }
  return null;
}
let esbuild;
async function readSource(url) {
  const content = await fs.promises.readFile(fileURLToPath(url), `utf8`);
  const ext = path.extname(fileURLToPath(url));
  if (ext === `.ts` || ext === `.tsx`) {
    const { transform } = esbuild ?? (esbuild ??= await import('esbuild'));
    return (await transform(content, {
      format: `esm`,
      jsxFactory: `h`,
      jsxFragment: `Fragment`,
      loader: ext === `.tsx` ? `tsx` : `ts`,
      target: `esnext`
    })).code;
  }
  if (ext === `.json`)
    return `const data = ${content};export default data;`;
  return content;
}

async function getFormat$1(resolved, context, defaultGetFormat) {
  const url = tryParseURL(resolved);
  if (url?.protocol !== `file:`)
    return defaultGetFormat(resolved, context, defaultGetFormat);
  const format = getFileFormat(fileURLToPath(url));
  if (format) {
    return {
      format
    };
  }
  return defaultGetFormat(resolved, context, defaultGetFormat);
}

async function getSource$1(urlString, context, defaultGetSource) {
  const url = tryParseURL(urlString);
  if (url?.protocol !== `file:`)
    return defaultGetSource(urlString, context, defaultGetSource);
  return {
    source: await readSource(url)
  };
}

async function load$1(urlString, context, defaultLoad) {
  const url = tryParseURL(urlString);
  if (url?.protocol !== `file:`)
    return defaultLoad(urlString, context, defaultLoad);
  const filePath = fileURLToPath(url);
  const format = getFileFormat(filePath);
  if (!format)
    return defaultLoad(urlString, context, defaultLoad);
  return {
    format,
    source: await readSource(url)
  };
}

const builtins = new Set([...moduleExports.builtinModules]);
const pathRegExp = /^(?![a-zA-Z]:[\\/]|\\\\|\.{0,2}(?:\/|$))((?:node:)?(?:@[^/]+\/)?[^/]+)\/*(.*|)$/;
async function resolve$1(originalSpecifier, context, defaultResolver) {
  const { findPnpApi } = moduleExports;
  if (!findPnpApi || builtins.has(originalSpecifier))
    return defaultResolver(originalSpecifier, context, defaultResolver);
  let specifier = originalSpecifier;
  const url = tryParseURL(specifier);
  if (url) {
    if (url.protocol !== `file:` || specifier.startsWith(`node:`))
      return defaultResolver(originalSpecifier, context, defaultResolver);
    try {
      specifier = fileURLToPath(specifier);
    } catch {
      specifier = fileURLToPath(pathToFileURL(specifier).href);
    }
  }
  const { parentURL, conditions = [] } = context;
  const issuer = parentURL ? fileURLToPath(parentURL) : process.cwd();
  const pnpapi = findPnpApi(issuer) ?? (url ? findPnpApi(specifier) : null);
  if (!pnpapi)
    return defaultResolver(originalSpecifier, context, defaultResolver);
  const dependencyNameMatch = specifier.match(pathRegExp);
  if (dependencyNameMatch) {
    const [, dependencyName, subPath] = dependencyNameMatch;
    if (subPath === ``) {
      const resolved = pnpapi.resolveToUnqualified(`${dependencyName}/package.json`, issuer);
      if (resolved) {
        const content = await tryReadFile(resolved);
        if (content) {
          const pkg = JSON.parse(content);
          pkg.exports == null;
        }
      }
    }
  }
  let query;
  if (specifier.includes(`?`))
    [specifier, query] = specifier.split(`?`);
  const result = pnpapi.resolveRequest(specifier, issuer, {
    conditions: new Set(conditions),
    extensions: [`.js`, `.ts`, `.tsx`, `.cjs`, `.mjs`, `.json`]
  });
  if (!result)
    throw new Error(`Resolving '${specifier}' from '${issuer}' failed`);
  return {
    url: pathToFileURL(query ? `${result}?${query}` : result).href
  };
}

const binding = process.binding(`fs`);
const originalfstat = binding.fstat;
const ZIP_FD = 2147483648;
binding.fstat = function(...args) {
  const [fd, useBigint, req] = args;
  if ((fd & ZIP_FD) !== 0 && useBigint === false && req === void 0) {
    try {
      const stats = fs.fstatSync(fd);
      return new Float64Array([
        stats.dev,
        stats.mode,
        stats.nlink,
        stats.uid,
        stats.gid,
        stats.rdev,
        stats.blksize,
        stats.ino,
        stats.size,
        stats.blocks
      ]);
    } catch {
    }
  }
  return originalfstat.apply(this, args);
};

const [major, minor] = process.versions.node.split(`.`).map((value) => parseInt(value, 10));
const hasConsolidatedHooks = major > 16 || major === 16 && minor >= 12;
const resolve = resolve$1;
const getFormat = hasConsolidatedHooks ? void 0 : getFormat$1;
const getSource = hasConsolidatedHooks ? void 0 : getSource$1;
const load = hasConsolidatedHooks ? load$1 : void 0;

export { getFormat, getSource, load, resolve };
