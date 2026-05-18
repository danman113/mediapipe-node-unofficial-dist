#!/usr/bin/env node
/**
 * Build and publish artifacts to this dist repo in one step.
 *
 * Usage (from this dist repo):
 *   node build.js
 *   node build.js --source=~/dev/mediapipe   # override source repo path
 *   node build.js --no-build                 # skip bazel, use existing artifact
 *   node build.js --dry-run                  # preview without committing
 */

'use strict';

const {execSync, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIST_ROOT = __dirname;
const DEFAULT_SOURCE = path.join(os.homedir(), 'dev/mediapipe');
const BAZEL_TARGET = '//mediapipe/tasks/web/vision_node:vision_node_pkg';
const BAZEL_OUT = 'bazel-bin/mediapipe/tasks/web/vision_node/vision_node_pkg';

function parseArgs(argv) {
  let sourceRepo = DEFAULT_SOURCE;
  let build = true;
  let dryRun = false;
  for (const arg of argv) {
    if (arg.startsWith('--source='))
      sourceRepo = arg.slice(9).replace(/^~/, os.homedir());
    else if (arg === '--no-build')
      build = false;
    else if (arg === '--dry-run')
      dryRun = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node build.js [--source=<path>] [--no-build] [--dry-run]');
      process.exit(0);
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(64);
    }
  }
  return {sourceRepo: path.resolve(sourceRepo), build, dryRun};
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {cwd, stdio: 'inherit'});
  if (result.status !== 0) {
    console.error(`failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  const {sourceRepo, build, dryRun} = parseArgs(process.argv.slice(2));
  const pkgSrc = path.join(sourceRepo, BAZEL_OUT);
  const licenseSrc = path.join(sourceRepo, 'mediapipe/tasks/web/vision_node/LICENSE');

  if (!fs.existsSync(path.join(sourceRepo, 'WORKSPACE'))) {
    console.log(`Source repo not found at ${sourceRepo} — cloning...`);
    fs.mkdirSync(sourceRepo, {recursive: true});
    run('git', ['clone', 'https://github.com/danman113/mediapipe-node-unofficial.git', sourceRepo], os.homedir());
  } else {
    console.log('\n── git pull (source) ────────────────────────────────────');
    run('git', ['pull', 'origin', 'master'], sourceRepo);
  }

  if (build) {
    console.log('\n── bazel build ──────────────────────────────────────────');
    run('bazel', [
      'build',
      '--compilation_mode=opt',
      '--features=optimized_for_speed',
      BAZEL_TARGET,
    ], sourceRepo);
  }

  if (!fs.existsSync(pkgSrc)) {
    console.error(`Built package not found at:\n  ${pkgSrc}`);
    process.exit(1);
  }

  const sha = execSync('git rev-parse --short HEAD', {cwd: sourceRepo}).toString().trim();
  const fullSha = execSync('git rev-parse HEAD', {cwd: sourceRepo}).toString().trim();

  console.log(`\n── copy artifacts ───────────────────────────────────────`);
  console.log(`Source commit : ${sha}`);
  console.log(`Source repo   : ${sourceRepo}`);
  console.log(`Dist repo     : ${DIST_ROOT}\n`);

  if (dryRun) {
    console.log('(dry run — no changes made)');
    return;
  }

  // Clear dist repo, preserving repo-owned files (not bazel artifacts)
  const PRESERVE = new Set(['.git', '.gitignore', '.github', 'build.js', 'test']);
  for (const entry of fs.readdirSync(DIST_ROOT)) {
    if (PRESERVE.has(entry)) continue;
    fs.rmSync(path.join(DIST_ROOT, entry), {recursive: true, force: true});
  }

  // Copy built artifacts (-rL follows bazel's symlink farm)
  run('cp', ['-rL', `${pkgSrc}/.`, DIST_ROOT]);

  // Copy LICENSE
  if (fs.existsSync(licenseSrc)) {
    fs.copyFileSync(licenseSrc, path.join(DIST_ROOT, 'LICENSE'));
  }

  // Bazel sets everything read-only
  run('chmod', ['-R', 'u+w', DIST_ROOT]);

  console.log('\n── commit & push ────────────────────────────────────────');
  run('git', ['add', '-A'], DIST_ROOT);

  const status = spawnSync('git', ['status', '--porcelain'],
      {cwd: DIST_ROOT, encoding: 'utf8'});
  if (!status.stdout.trim()) {
    console.log('Nothing changed — dist repo already up to date.');
    return;
  }

  run('git', [
    'commit', '-m',
    `chore: dist from ${sha}\n\nSource: danman113/mediapipe-node-unofficial@${fullSha}`,
  ], DIST_ROOT);

  run('git', ['push'], DIST_ROOT);

  console.log(`\nDone. Install with:\n  npm install danman113/mediapipe-node-unofficial-dist`);
}

main();
