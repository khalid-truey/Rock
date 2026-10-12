import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {binaryDirectory} from './runtime.mjs';

test('launcher prefers packaged and release builds while preserving overrides and debug fallback', async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'rock-binary-selection-'));
  try {
    assert.equal(binaryDirectory(root,''),path.join(root,'target/debug'));
    await mkdir(path.join(root,'target/release'),{recursive:true});
    // An incomplete release directory must not mask the working debug build.
    assert.equal(binaryDirectory(root,''),path.join(root,'target/debug'));
    await writeFile(path.join(root,'target/release/rock.exe'),'fixture');
    assert.equal(binaryDirectory(root,''),path.join(root,'target/release'));
    await mkdir(path.join(root,'bin'));
    await writeFile(path.join(root,'bin/rock.exe'),'fixture');
    assert.equal(binaryDirectory(root,''),path.join(root,'bin'));
    assert.equal(binaryDirectory(root,'explicit-build'),'explicit-build');
  } finally { await rm(root,{recursive:true,force:true}); }
});
