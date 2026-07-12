#!/usr/bin/env node

const { spawn } = require('child_process');
const { XaiOAuthClient, XaiOAuthError } = require('../backend/xaiOAuthClient');

function printHelp() {
  console.log(`EasyCC X Search

Usage:
  x_search auth login [--no-browser]
  x_search auth status
  x_search auth logout
  x_search search <query> [options]

Search options:
  --allow <handle>    Search only this handle (repeatable, max 10)
  --exclude <handle>  Exclude this handle (repeatable, max 10)
  --from <YYYY-MM-DD> Earliest post date
  --to <YYYY-MM-DD>   Latest post date
  --images            Enable image understanding
  --videos            Enable video understanding
  --model <name>      Override the Grok model
  --json              Print the complete JSON result
`);
}

function openBrowser(url) {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    command = '/mnt/c/Windows/System32/rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function parseSearchArgs(args) {
  const options = {
    queryParts: [],
    allowedXHandles: [],
    excludedXHandles: [],
    enableImageUnderstanding: false,
    enableVideoUnderstanding: false,
    json: false
  };
  const valueOptions = new Map([
    ['--allow', 'allowedXHandles'],
    ['--exclude', 'excludedXHandles'],
    ['--from', 'fromDate'],
    ['--to', 'toDate'],
    ['--model', 'model']
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (valueOptions.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new XaiOAuthError(`${arg} requires a value`);
      const field = valueOptions.get(arg);
      if (Array.isArray(options[field])) options[field].push(value);
      else options[field] = value;
      index += 1;
    } else if (arg === '--images') {
      options.enableImageUnderstanding = true;
    } else if (arg === '--videos') {
      options.enableVideoUnderstanding = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg.startsWith('--')) {
      throw new XaiOAuthError(`Unknown option: ${arg}`);
    } else {
      options.queryParts.push(arg);
    }
  }

  options.query = options.queryParts.join(' ').trim();
  delete options.queryParts;
  return options;
}

function uniqueCitations(result) {
  const seen = new Set();
  const citations = [];
  for (const citation of [...result.citations, ...result.inlineCitations]) {
    const url = typeof citation === 'string' ? citation : citation?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    citations.push({ url, title: typeof citation === 'string' ? '' : citation.title || '' });
  }
  return citations;
}

async function login(client, args) {
  console.log('Requesting an xAI device login...');
  const flow = await client.beginDeviceLogin();
  const verificationUrl = flow.verificationUriComplete || flow.verificationUri;
  console.log(`\nOpen this link:\n${verificationUrl}\n`);
  console.log(`Verification code: ${flow.userCode}`);

  if (!args.includes('--no-browser')) {
    const opened = openBrowser(verificationUrl);
    console.log(opened ? 'Opened the link in your browser.' : 'Could not open a browser automatically. Use the link above.');
  }
  console.log('Waiting for you to approve access...');
  const status = await client.pollDeviceLogin(flow);
  console.log(`Signed in with xAI OAuth${status.expiresAt ? ` (access token expires ${status.expiresAt})` : ''}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const [command, subcommand] = args;
  const client = new XaiOAuthClient();

  if (!command || ['help', '--help', '-h'].includes(command)) {
    printHelp();
    return;
  }

  if (command === 'auth' && subcommand === 'login') {
    await login(client, args.slice(2));
    return;
  }
  if (command === 'auth' && subcommand === 'status') {
    const status = await client.status();
    if (!status.connected) {
      console.log('Not signed in. Run: x_search auth login');
      process.exitCode = 1;
      return;
    }
    console.log(`Connected via xAI OAuth${status.expiresAt ? `; access token expires ${status.expiresAt}` : ''}.`);
    return;
  }
  if (command === 'auth' && subcommand === 'logout') {
    await client.logout();
    console.log('Removed the local xAI OAuth session.');
    return;
  }
  if (command === 'search') {
    const options = parseSearchArgs(args.slice(1));
    const result = await client.search(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(result.answer || '(No answer returned)');
    const citations = uniqueCitations(result);
    if (citations.length) {
      console.log('\nSources:');
      citations.forEach((citation, index) => {
        console.log(`${index + 1}. ${citation.title ? `${citation.title} — ` : ''}${citation.url}`);
      });
    } else if (result.degraded) {
      console.log('\nWarning: xAI returned no X citations for the requested filters.');
    }
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch(error => {
  const message = error instanceof XaiOAuthError ? error.message : `Unexpected error: ${error.message}`;
  console.error(`Error: ${message}`);
  if (error.reloginRequired) console.error('Run: x_search auth login');
  process.exitCode = 1;
});
