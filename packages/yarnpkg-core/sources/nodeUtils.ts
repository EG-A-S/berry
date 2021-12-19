import Module from 'module';

export function builtinModules(): Set<string> {
  // @ts-expect-error
  const builtins = Module.builtinModules || Object.keys(process.binding(`natives`));

  return new Set([...builtins, ...builtins.map(module => `node:${module}`)]);
}
