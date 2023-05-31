import esbuild          from 'esbuild';
import fs               from 'fs';
import path             from 'path';
import {fileURLToPath}  from 'url';

import * as loaderUtils from './loaderUtils';

export async function resolve(
  originalSpecifier: string,
  context: unknown,
  nextResolve: typeof resolve,
): Promise<{ url: string, shortCircuit: boolean }> {
  return nextResolve(originalSpecifier, context, nextResolve);
}

export async function load(
  urlString: string,
  context: {
    format: string | null | undefined;
    importAssertions?: {
      type?: 'json';
    };
  },
  nextLoad: typeof load,
): Promise<{ format: string, source: string, shortCircuit: boolean }> {
  const url = loaderUtils.tryParseURL(urlString);
  if (url?.protocol !== `file:`)
    return nextLoad(urlString, context, nextLoad);

  const filePath = fileURLToPath(url);

  const format = loaderUtils.getFileFormat(filePath);
  if (!format)
    return nextLoad(urlString, context, nextLoad);

  const ext = path.extname(fileURLToPath(url));
  if (!(ext === `.ts` || ext === `.tsx`))
    return nextLoad(urlString, context, nextLoad);

  const content = await fs.promises.readFile(fileURLToPath(url), `utf8`);

  const {code: transformedSource} = await esbuild.transform(content, {
    format: `esm`,
    jsx: `automatic`,
    jsxDev: process.env.NODE_ENV === `development`,
    jsxImportSource: `preact`,
    loader: ext === `.tsx` ? `tsx` : `ts`,
    target: `esnext`,
  });

  return {
    format,
    source: transformedSource,
    shortCircuit: true,
  };
}
