import * as util from 'node:util';

const requiredNode = [20, 12, 0];
const [major, minor, patch] = process.versions.node.split('.').map(Number);

function isSupportedNode() {
  if (major > requiredNode[0]) {
    return true;
  }

  if (major < requiredNode[0]) {
    return false;
  }

  if (minor > requiredNode[1]) {
    return true;
  }

  if (minor < requiredNode[1]) {
    return false;
  }

  return patch >= requiredNode[2];
}

if (!isSupportedNode()) {
  console.error(
    [
      'Unsupported Node.js runtime.',
      `Found ${process.version}; IsaFlow tests require Node.js >=${requiredNode.join('.')}.`,
      'Vitest 4/Rolldown imports node:util styleText, which is not available before Node.js 20.12.0.',
      'Upgrade Node, then rerun bun install and bun run test:unit.',
    ].join('\n')
  );
  process.exit(1);
}

if (typeof util.styleText !== 'function') {
  console.error('Unsupported Node.js runtime: node:util styleText is unavailable.');
  process.exit(1);
}
