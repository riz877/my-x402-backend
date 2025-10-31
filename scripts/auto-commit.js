const { execSync } = require('child_process');
const fs = require('fs');

function run(cmd) {
  try {
    const out = execSync(cmd, { stdio: 'pipe' }).toString().trim();
    return out;
  } catch (e) {
    return null;
  }
}

console.log('Checking git status...');
const status = run('git status --porcelain');
if (!status) {
  console.log('No changes to commit.');
  process.exit(0);
}

console.log('Staging changes...');
run('git add -A');

const message = process.argv[2] || 'chore: auto commit changes by assistant';
console.log('Committing with message:', message);
const commit = run(`git commit -m "${message}"`);
if (commit === null) {
  console.error('Nothing to commit or commit failed.');
  process.exit(1);
}
console.log('Pushing to remote...');
const push = run('git push');
if (push === null) {
  console.error('Push failed.');
  process.exit(1);
}
console.log('Auto-commit complete.');
