const assert = require(`assert`);
const cp = require(`child_process`);
const crypto = require(`crypto`);
const fs = require(`fs`);
const https = require(`https`);
const path = require(`path/posix`);
const semver = require(`semver`);

const POSIX_DIRNAME = process.platform === `win32` ? __dirname.replaceAll(`\\`, `/`) : __dirname;

const TS_REPO = `/tmp/ts-repo-treeless`;
const TS_REPO_SPAWN = {cwd: TS_REPO, shell: process.platform === `win32`};

const TMP_DIR = `/tmp/ts-builds`;

const IGNORED_VERSIONS = new Set([
  `3.3.3333`,
  `3.7.0-beta`,
  `3.9.0-beta`,
  `4.0.0-beta`,
  `4.3.0-beta`,
  `4.4.0-beta`,
  // Broken publish - missing files
  `4.9.0-beta`,
]);

const SLICES = [
  // https://github.com/mestro-se/TypeScript/tree/mestro
  {
    from: `b8809faeb8545d0eeca0432de4655cab12ece158`,
    to: `b8809faeb8545d0eeca0432de4655cab12ece158`,
    onto: `79a851426c514a12a75b342e8dd2460ee6615f73`,
    range: `>=5.6.0`,
  },
];

async function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if (!(res.statusCode >= 200 && res.statusCode < 300))
        throw new Error(`Failed to fetch ${url}`);

      const chunks = [];

      res.on(`error`, err => {
        reject(err);
      });

      res.on(`data`, chunk => {
        chunks.push(chunk);
      });

      res.on(`end`, () => {
        resolve(Buffer.concat(chunks));
      });
    });

    req.on(`error`, err => {
      reject(err);
    });
  });
}

async function execFile(binary, args, {checkExitCode = true, ...opts} = {}) {
  console.log(`${binary} ${args.join(` `)}`);

  return new Promise((resolve, reject) => {
    const child = cp.spawn(binary, args, {
      ...opts,
      env: {
        ...process.env,
        NODE_OPTIONS: undefined,
      },
    });

    const outChunks = [];
    const allChunks = [];

    child.stdout.on(`data`, chunk => {
      outChunks.push(chunk);
      allChunks.push(chunk);
    });

    child.stderr.on(`data`, chunk => {
      allChunks.push(chunk);
    });

    child.on(`error`, err => {
      err.message += `\n\n${Buffer.concat(allChunks).toString()}\n`;
      reject(err);
    });

    child.on(`close`, code => {
      if (code === 0 || !checkExitCode) {
        resolve(Buffer.concat(outChunks));
      } else {
        reject(new Error(`The process exited\n\n${Buffer.concat(allChunks).toString()}\n`));
      }
    });
  });
}

let relevantVersions;

async function fetchVersions(range) {
  if (typeof relevantVersions === `undefined`) {
    const data = await fetch(`https://registry.yarnpkg.com/typescript`);
    const allVersions = Object.keys(JSON.parse(data.toString()).versions);

    relevantVersions = [];

    for (const version of allVersions) {
      if (IGNORED_VERSIONS.has(version))
        continue;

      const pre = semver.prerelease(version);
      if (pre && pre[0] !== `beta` && pre[0] !== `rc`)
        continue;

      relevantVersions.push(version);
    }
  }

  const versions = [];

  for (const version of relevantVersions) {
    const parsed = semver.parse(version);

    const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    if (!semver.satisfies(base, range))
      continue;

    versions.push(version);
  }

  return versions;
}

async function cloneRepository() {
  if (!fs.existsSync(TS_REPO))
    await execFile(`git`, [`clone`, `--filter=tree:0`, `https://github.com/mestro-se/TypeScript`, TS_REPO]);

  try {
    await execFile(`git`, [`cherry-pick`, `--abort`], TS_REPO_SPAWN);
  } catch {}

  await execFile(`git`, [`config`, `user.email`, `you@example.com`], TS_REPO_SPAWN);
  await execFile(`git`, [`config`, `user.name`, `Your Name`], TS_REPO_SPAWN);

  await execFile(`git`, [`fetch`, `origin`], TS_REPO_SPAWN);
}

async function resetGit(hash) {
  await execFile(`git`, [`reset`, `--hard`, hash], TS_REPO_SPAWN);
  await execFile(`git`, [`clean`, `-df`], TS_REPO_SPAWN);
}

async function buildRepository({from, to, onto, volta}) {
  const code = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, `0`);
  const tmpDir = path.join(TMP_DIR, `${code}`);

  await resetGit(onto);

  const date = await execFile(`git`, [`show`, `-s`, `--format=%ci`], TS_REPO_SPAWN);

  if (to) {
    let isAncestor;
    try {
      await execFile(`git`, [`merge-base`, `--is-ancestor`, onto, to], TS_REPO_SPAWN);
      isAncestor = true;
    } catch {
      isAncestor = false;
    }

    if (isAncestor) {
      await execFile(`git`, [`merge`, `--no-edit`, to], TS_REPO_SPAWN);
    } else {
      await execFile(`git`, [`cherry-pick`, `${from}^..${to}`], TS_REPO_SPAWN);
    }
  }

  {
    const pkgPath = path.join(TS_REPO, `package.json`);
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, `utf8`));

    assert(!(pkg.volta?.node && volta?.node), `node version is already set for ${pkg.version}`);
    assert(!(pkg.volta?.npm && volta?.npm), `npm version is already set for ${pkg.version}`);

    const voltaConfig = {
      ...volta,
      ...pkg.volta,
    };
    assert(voltaConfig.node && voltaConfig.npm, `Missing complete volta configuration for ${pkg.version}, current config: ${JSON.stringify(voltaConfig)}`);

    if (JSON.stringify(pkg.volta) !== JSON.stringify(voltaConfig)) {
      pkg.volta = voltaConfig;
      await fs.promises.writeFile(pkgPath, JSON.stringify(pkg, null, 4));
    }
  }

  if (fs.existsSync(path.join(TS_REPO, `package-lock.json`)))
    await execFile(`npm`, [`ci`], TS_REPO_SPAWN);
  else
    await execFile(`npm`, [`install`, `--before`, date.toString().trim()], TS_REPO_SPAWN);

  await execFile(process.platform === `win32` ? `node_modules\\.bin\\hereby.cmd` : `./node_modules/.bin/hereby`, [`local`, `LKG`], TS_REPO_SPAWN);

  // It seems that in some circumstances the build can produce incorrect artifacts. When
  // that happens, the final binary is very small. We try to detect that.
  const stat = await fs.promises.stat(path.join(TS_REPO, `lib/typescript.js`));
  if (stat.size < 100000)
    throw new Error(`Something is wrong; typescript.js got generated with a stupid size`);

  await fs.promises.mkdir(tmpDir, {recursive: true});
  await fs.promises.cp(path.join(TS_REPO, `lib`), path.join(tmpDir, `lib`), {recursive: true});

  await fs.promises.rm(path.join(TS_REPO, `lib`), {recursive: true, force: true});
  await execFile(`git`, [`reset`, `--hard`], TS_REPO_SPAWN);

  return tmpDir;
}

async function run({from, to, onto, range, volta}) {
  const hash = crypto
    .createHash(`md5`)
    .update(JSON.stringify({from, to, onto}))
    .digest(`hex`);

  const patchFile = path.join(POSIX_DIRNAME, `patch-${hash}.diff`);
  if (fs.existsSync(patchFile)) {
    const originalContent = await fs.promises.readFile(patchFile, `utf8`);
    const updatedContent = originalContent.replace(/^semver exclusivity .*\n/gm, `semver exclusivity ${range}\n`);
    if (originalContent !== updatedContent) {
      console.log(`Updating range for ${path.basename(patchFile)}`);
      await fs.promises.writeFile(patchFile, updatedContent);
      return {patchFile, content: updatedContent};
    } else {
      console.log(`Skipping; patch ${path.basename(patchFile)} already exists`);
      return {patchFile, content: originalContent};
    }
  }

  await cloneRepository();

  const base = await buildRepository({onto, volta});
  const patched = await buildRepository({from, to, onto, volta});

  const buffer = await execFile(`git`, [`diff`, `--no-index`, base, patched], {checkExitCode: false});

  let patch = buffer.toString();
  patch = patch.replace(/^--- /gm, `semver exclusivity ${range}\n--- `);
  patch = patch.replace(new RegExp(`${base}/`, `g`), `/`);
  patch = patch.replace(new RegExp(`${patched}/`, `g`), `/`);
  patch = patch.replace(new RegExp(`${patched}/`, `g`), `/`);

  await fs.promises.writeFile(patchFile, patch);

  return {patchFile, content: patch};
}

async function validate(version, patch) {
  const tmpDir = path.join(TMP_DIR, `v${version}`);
  const tarball = path.join(tmpDir, `package.tgz`);

  await fs.promises.mkdir(tmpDir, {recursive: true});

  if (!fs.existsSync(tarball)) {
    const data = await fetch(`https://registry.yarnpkg.com/typescript/-/typescript-${version}.tgz`);
    await fs.promises.writeFile(tarball, data);
  }

  if (!fs.existsSync(path.join(tmpDir, `package`)))
    await execFile(`tar`, [`xvf`, posixPathToNativePath(tarball)], {cwd: tmpDir});

  const patchContent = patch.content.replace(/^semver exclusivity .*\n/gm, ``);
  await fs.promises.writeFile(path.join(tmpDir, `patch.diff`), patchContent);

  await execFile(`git`, [`apply`, `--check`, `../patch.diff`], {cwd: path.join(tmpDir, `package`)});
}

async function main() {
  const patches = [];
  let isFirst = true;

  for (const slice of SLICES) {
    if (!isFirst)
      console.log();

    isFirst = false;

    console.log(`## Slice: ${JSON.stringify(slice)}`);
    console.log();

    const patch = await run(slice);
    const versions = await fetchVersions(slice.range);

    await Promise.all(versions.map(async version => {
      console.log(`Validating ${version}...`);
      await validate(version, patch);
    }));

    patches.push(patch);
  }

  const aggregatePatchFile = path.join(TMP_DIR, `patch.diff`);
  await fs.promises.writeFile(aggregatePatchFile, patches.map(patch => patch.content).join(``));

  const jsPatchFile = path.join(POSIX_DIRNAME, `../../sources/patches/typescript.patch.ts`);
  await execFile(`node`, [path.join(POSIX_DIRNAME, `../createPatch.js`), aggregatePatchFile, jsPatchFile]);

  // Remove old patches
  const patchFilesSet = new Set(patches.map(patch => patch.patchFile));
  for await (const {name: patchName} of await fs.promises.opendir(POSIX_DIRNAME)) {
    if (patchName.endsWith(`.diff`) && !patchFilesSet.has(path.join(POSIX_DIRNAME, patchName))) {
      console.log(`Cleanup; file ${patchName} not in use`);
      await fs.promises.unlink(path.join(POSIX_DIRNAME, patchName));
    }
  }
}

function posixPathToNativePath(posixPath) {
  return process.platform === `win32` ? posixPath.replaceAll(`/`, `\\`) : posixPath;
}

main().catch(err => {
  console.error(err.stack);
  process.exitCode = 1;
});
