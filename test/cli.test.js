const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const cliPath = path.resolve(__dirname, '..', 'dist', 'cli.js');

async function runCli(args, options = {}) {
  const { input, cwd } = options;
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    if (input !== undefined) {
      proc.stdin.write(input);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

function parseJson(output) {
  return JSON.parse(output.trim());
}

function buildDataUrl(html) {
  return `data:text/html,${encodeURIComponent(html)}`;
}

test('returns error when no input provided', async () => {
  const result = await runCli([]);
  assert.equal(result.code, 1);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error.message, /No input provided/);
});

test('runs goto + waitFor + evaluate against data URL', async () => {
  const url = buildDataUrl('<!doctype html><title>Example</title><div id="root">ok</div>');
  const input = {
    actions: [
      { type: 'goto', url },
      { type: 'waitFor', selector: '#root' },
      { type: 'evaluate', expression: 'document.title' }
    ]
  };

  const result = await runCli(['--json', JSON.stringify(input)]);
  assert.equal(result.code, 0);

  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.results.length, 3);
  assert.equal(payload.results[2].data.result, 'Example');
});

test('writes screenshot to the requested path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-browser-'));
  const screenshotPath = 'shot.png';
  const url = buildDataUrl('<!doctype html><title>Shot</title><div>capture</div>');
  const input = {
    actions: [
      { type: 'goto', url },
      { type: 'screenshot', path: screenshotPath }
    ]
  };

  const result = await runCli(['--json', JSON.stringify(input)], { cwd: tempDir });
  assert.equal(result.code, 0);

  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  const fullPath = path.join(tempDir, screenshotPath);
  const stat = await fs.stat(fullPath);
  assert.ok(stat.size > 0);
});

test('writes output to file when requested', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-browser-'));
  const outputPath = 'out.json';
  const url = buildDataUrl('<!doctype html><title>Out</title>');
  const input = {
    actions: [
      { type: 'goto', url },
      { type: 'evaluate', expression: 'document.title' }
    ]
  };

  const result = await runCli(
    ['--json', JSON.stringify(input), '--output', outputPath],
    { cwd: tempDir }
  );
  assert.equal(result.code, 0);

  const outputRaw = await fs.readFile(path.join(tempDir, outputPath), 'utf8');
  const payload = parseJson(outputRaw);
  assert.equal(payload.ok, true);
});

test('supports saveAs values for templated actions', async () => {
  const nextUrl = buildDataUrl('<!doctype html><title>Second</title><div id="next">ok</div>');
  const startUrl = buildDataUrl(
    `<!doctype html><title>First</title><a id="next" href="${nextUrl}">go</a>`
  );
  const input = {
    actions: [
      { type: 'goto', url: startUrl },
      { type: 'evaluate', expression: "document.querySelector('#next').href", saveAs: 'nextUrl' },
      { type: 'goto', url: '{{nextUrl}}' },
      { type: 'evaluate', expression: 'document.title' }
    ]
  };

  const result = await runCli(['--json', JSON.stringify(input)]);
  assert.equal(result.code, 0);

  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.results[1].savedAs, 'nextUrl');
  assert.equal(payload.variables.nextUrl, nextUrl);
  assert.equal(payload.results[3].data.result, 'Second');
});
