# codex-browser

Minimal Playwright (Chromium) CLI with a small, predictable JSON surface for browser automation.

## Install

```bash
npm install
npx playwright install chromium
npm run build
```

## Usage

```bash
codex-browser --input request.json
codex-browser --json '{"actions":[{"type":"goto","url":"https://example.com"}]}'
cat request.json | codex-browser
```

### CI / Agent-friendly flags

- `--trace-on-failure <dir>`: write a Playwright trace zip only if a step fails
- `--capture-console`: include browser `console` + `pageerror` entries in the JSON output

CLI flags:

- `--headed`: run with a visible browser window (overrides `options.headless`)
- `--headless`: run without a visible browser window (default; overrides `options.headless`)

## Input JSON

Top-level shape:

```json
{
  "options": {
    "headless": true,
    "slowMoMs": 0,
    "defaultTimeoutMs": 30000,
    "defaultNavigationTimeoutMs": 30000,
    "viewport": { "width": 1280, "height": 720 },
    "userAgent": "...",
    "locale": "en-US",
    "timezoneId": "UTC",
    "ignoreHTTPSErrors": false,
    "traceOnFailureDir": "./artifacts",
    "captureConsole": false
  },
  "actions": [
    { "type": "goto", "url": "https://example.com" },
    { "type": "waitFor", "selector": "text=Example Domain" },
    { "type": "evaluate", "expression": "document.title" }
  ]
}
```

Supported actions (in order):

- `goto`: `{ type, url, waitUntil?, timeoutMs? }`
- `waitFor`: `{ type, selector, state?, timeoutMs? }`
- `waitForLoadState`: `{ type, state?, timeoutMs? }`
- `click`: `{ type, selector, button?, clickCount?, delayMs?, timeoutMs? }`
- `fill`: `{ type, selector, text, timeoutMs? }`
- `press`: `{ type, key, selector?, timeoutMs? }`
- `screenshot`: `{ type, path, fullPage? }`
- `evaluate`: `{ type, expression }`
- `setViewport`: `{ type, width, height }`
- `wait`: `{ type, ms }`

Notes:

- `evaluate.expression` must be a JavaScript expression that returns a serializable value.
- Paths in `screenshot.path` are resolved relative to the current working directory.
- Every action supports `saveAs` to store its output in a variable name.
- String fields support templating with `{{var}}` or `{{var.path}}` for stored values.
- Prefer `waitFor`/`waitForLoadState` over `wait` to avoid nondeterministic sleeps.

Example with `saveAs` + templates:

```json
{
  "actions": [
    {
      "type": "evaluate",
      "expression": "({ nextUrl: document.querySelector('a').href })",
      "saveAs": "page"
    },
    { "type": "goto", "url": "{{page.nextUrl}}" }
  ]
}
```

## Output JSON

Success:

```json
{
  "ok": true,
  "results": [
    { "type": "goto", "ok": true, "data": { "url": "https://example.com", "status": 200 } },
    { "type": "evaluate", "ok": true, "data": { "result": "Example Domain" } }
  ],
  "timingMs": 421,
  "variables": {
    "savedValue": "..."
  }
}
```

Error:

```json
{
  "ok": false,
  "error": {
    "code": "PLAYWRIGHT_TIMEOUT",
    "name": "TimeoutError",
    "message": "Timeout 30000ms exceeded.",
    "stepIndex": 2,
    "action": { "type": "waitFor", "selector": "#does-not-exist", "timeoutMs": 30000 }
  }
}
```
