const cp = require('child_process');
const args = process.argv.slice(2);
console.log('LAUNCHER ARGS:', JSON.stringify(args));
cp.spawn(args[0], args.slice(1), { stdio: 'ignore', windowsHide: true });
