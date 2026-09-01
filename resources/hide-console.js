/**
 * hide-console.js
 *
 * Drop-in replacement for hidden-console-launcher.exe.
 * Spawns the target process with windowsHide:true so no console window is
 * created.  The shim already adds windowsHide to child_process.spawn, but
 * the original launcher itself briefly creates a visible console before
 * suppressing it — this script avoids that entirely.
 */
'use strict';
const cp = require('child_process');
const args = process.argv.slice(2);
if (args.length === 0) process.exit(1);
const cmd = args[0];
const cmdArgs = args.slice(1);
try {
  const child = cp.spawn(cmd, cmdArgs, {
    stdio: 'ignore',
    windowsHide: true,
    detached: false,
  });
  child.on('error', () => {});
} catch {}
