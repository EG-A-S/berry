import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { URL, fileURLToPath } from 'url';
import { npath } from '@yarnpkg/fslib';
import { Module } from 'module';

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
