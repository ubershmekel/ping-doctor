/**
 * Release script: runs tests, bumps version, builds the extension, strips source maps, zips dist/, commits, and pushes.
 * Usage: npm run release [patch|minor|major]  (defaults to patch)
 * Output: releases/ping-doctor-<version>.zip (ready for Chrome Web Store upload)
 */

import { execSync } from 'node:child_process';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const rootDir = resolve(fileURLToPath(import.meta.url), '..', '..');
const distDir = join(rootDir, 'dist');
const releasesDir = join(rootDir, 'releases');

type BumpType = 'patch' | 'minor' | 'major';
const bump = (process.argv[2] ?? 'patch') as BumpType;
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`Invalid bump type "${bump}". Use patch, minor, or major.`);
  process.exit(1);
}

function bumpVersion(version: string, type: BumpType): string {
  const [major, minor, patch] = version.split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Run tests first
console.log('Running tests...');
execSync('npm test', { stdio: 'inherit', cwd: rootDir });
console.log('Tests passed.');

// Bump manifest.json
const manifestPath = join(rootDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const newVersion = bumpVersion(manifest.version, bump);
manifest.version = newVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// Bump package.json to stay in sync
const pkgPath = join(rootDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`Bumped version to ${newVersion}`);

// Build
console.log(`Building ${manifest.name} v${newVersion}...`);
execSync('npm run build', { stdio: 'inherit', cwd: rootDir });

// Strip source maps
console.log('Stripping source maps...');
function removeMapFiles(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      removeMapFiles(full);
    } else if (entry.endsWith('.map')) {
      rmSync(full);
    }
  }
}
removeMapFiles(distDir);

// Zip into releases/
mkdirSync(releasesDir, { recursive: true });
const zipName = `${manifest.name.toLowerCase().replace(/\s+/g, '-')}-${newVersion}.zip`;
const zipPath = join(releasesDir, zipName);

console.log(`Creating releases/${zipName}...`);
await new Promise<void>((resolve, reject) => {
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  output.on('close', resolve);
  archive.on('error', reject);

  archive.pipe(output);
  archive.directory(distDir, false);
  archive.finalize();
});

// Commit version bump and push
console.log('Committing version bump...');
execSync(`git add manifest.json package.json`, { stdio: 'inherit', cwd: rootDir });
execSync(`git commit -m "v${newVersion}"`, { stdio: 'inherit', cwd: rootDir });
execSync(`git push`, { stdio: 'inherit', cwd: rootDir });
console.log(`Pushed v${newVersion}`);

console.log(`\nRelease ready: releases/${zipName}`);
console.log('Upload this file to https://chrome.google.com/webstore/devconsole');
console.log('See PUBLISHING.md for step-by-step instructions.');
