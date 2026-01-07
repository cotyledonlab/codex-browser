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
    "ignoreHTTPSErrors": false
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
    "name": "Error",
    "message": "..."
  }
}
```
