import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { URL, fileURLToPath } from 'url';
import { Module } from 'module';

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
const UNC_WINDOWS_PATH_REGEXP = /^\/\/(\.\/)?(.*)$/;
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
  p = p.replace(/\\/g, `/`);
  let windowsPathMatch, uncWindowsPathMatch;
  if (windowsPathMatch = p.match(WINDOWS_PATH_REGEXP))
    p = `/${windowsPathMatch[1]}`;
  else if (uncWindowsPathMatch = p.match(UNC_WINDOWS_PATH_REGEXP))
    p = `/unc/${uncWindowsPathMatch[1] ? `.dot/` : ``}${uncWindowsPathMatch[2]}`;
  return p;
}

process.versions.node.split(`.`).map((value) => parseInt(value, 10));

new Set(Module.builtinModules || Object.keys(process.binding(`natives`)));
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

function tryParseURL(str, base) {
  try {
    return new URL(str, base);
  } catch {
    return null;
  }
}
let entrypointPath = null;
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
      return `module`;
    }
    case `.json`: {
      return `json`;
    }
    case `.js`: {
      const pkg = readPackageScope(filepath);
      if (!pkg)
        return `commonjs`;
      return pkg.data.module ? `module` : pkg.data.type ?? `commonjs`;
    }
    default: {
      if (entrypointPath !== filepath)
        return null;
      const pkg = readPackageScope(filepath);
      if (!pkg)
        return `commonjs`;
      if (pkg.data.type === `module`)
        return null;
      return pkg.data.type ?? `commonjs`;
    }
  }
}

async function resolve(originalSpecifier, context, nextResolve) {
  return nextResolve(originalSpecifier, context, nextResolve);
}
async function load(urlString, context, nextLoad) {
  const url = tryParseURL(urlString);
  if (url?.protocol !== `file:`)
    return nextLoad(urlString, context, nextLoad);
  const filePath = fileURLToPath(url);
  const format = getFileFormat(filePath);
  if (!format)
    return nextLoad(urlString, context, nextLoad);
  const ext = path.extname(fileURLToPath(url));
  if (!(ext === `.ts` || ext === `.tsx`))
    return nextLoad(urlString, context, nextLoad);
  const content = await fs.promises.readFile(fileURLToPath(url), `utf8`);
  const { code: transformedSource } = await esbuild.transform(content, {
    format: `esm`,
    jsx: `automatic`,
    jsxDev: process.env.NODE_ENV === `development`,
    jsxImportSource: `preact`,
    loader: ext === `.tsx` ? `tsx` : `ts`,
    target: `esnext`
  });
  return {
    format,
    source: transformedSource,
    shortCircuit: true
  };
}

export { load, resolve };
