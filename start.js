#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const uiDistPath = path.join(__dirname, 'ui', 'dist');
const uiPath = path.join(__dirname, 'ui');
const backendPath = path.join(__dirname, 'backend');

// Check if UI is built
if (!fs.existsSync(uiDistPath)) {
  console.log('UI not built. Building...');
  try {
    execSync('npm run build', { cwd: uiPath, stdio: 'inherit' });
    console.log('UI build complete.');
  } catch (error) {
    console.error('Failed to build UI:', error.message);
    process.exit(1);
  }
}

// Start the backend server
console.log('Starting Claude Manager server...');
const server = spawn('node', ['server.js'], {
  cwd: backendPath,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', PORT: '5010' }
});

server.on('error', (error) => {
  console.error('Failed to start server:', error.message);
  process.exit(1);
});

server.on('close', (code) => {
  if (code !== 0) {
    console.error(`Server exited with code ${code}`);
  }
  process.exit(code);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  server.kill('SIGTERM');
});
