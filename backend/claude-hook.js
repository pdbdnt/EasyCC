#!/usr/bin/env node
// EasyCC Claude Code hook script
// Receives hook JSON on stdin, forwards to EasyCC backend.
// Designed to run async — exits silently on any error.

const http = require('http');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const req = http.request('http://localhost:5010/api/hook-event', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(input),
    },
    timeout: 3000,
  }, () => {
    process.exit(0);
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(input);
});
process.stdin.on('error', () => process.exit(0));
