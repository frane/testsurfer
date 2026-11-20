/**
 * `node --import testsurfer/register` installs the resolve hooks in
 * hooks.ts: Playwright imports point at testsurfer, extensionless
 * relative imports resolve. The `testsurfer test` command adds it.
 */

import { register } from 'node:module';

const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
register(new URL(`./hooks${ext}`, import.meta.url).href, import.meta.url);
