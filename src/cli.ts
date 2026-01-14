#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { chromium, type Browser, type Page } from 'playwright';

type ConsoleEntry = {
  type: string;
  text: string;
  location?: { url: string; lineNumber: number; columnNumber: number };
};

type PageErrorEntry = {
  message: string;
  stack?: string;
};

type ErrorCode =
  | 'INVALID_INPUT'
  | 'TEMPLATE_ERROR'
  | 'INTERRUPTED'
  | 'PLAYWRIGHT_TIMEOUT'
  | 'PLAYWRIGHT_ERROR'
  | 'UNKNOWN';

type Viewport = {
  width: number;
  height: number;
};

type Options = {
  headless?: boolean;
  slowMoMs?: number;
  defaultTimeoutMs?: number;
  defaultNavigationTimeoutMs?: number;
  viewport?: Viewport;
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  ignoreHTTPSErrors?: boolean;
  traceOnFailureDir?: string;
  captureConsole?: boolean;
};

type ActionBase = {
  type: string;
  saveAs?: string;
};

type GotoAction = ActionBase & {
  type: 'goto';
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeoutMs?: number;
};

type WaitForAction = ActionBase & {
  type: 'waitFor';
  selector: string;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
  timeoutMs?: number;
};

type WaitForLoadStateAction = ActionBase & {
  type: 'waitForLoadState';
  state?: 'load' | 'domcontentloaded' | 'networkidle';
  timeoutMs?: number;
};

type ClickAction = ActionBase & {
  type: 'click';
  selector: string;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delayMs?: number;
  timeoutMs?: number;
};

type FillAction = ActionBase & {
  type: 'fill';
  selector: string;
  text: string;
  timeoutMs?: number;
};

type PressAction = ActionBase & {
  type: 'press';
  key: string;
  selector?: string;
  timeoutMs?: number;
};

type ScreenshotAction = ActionBase & {
  type: 'screenshot';
  path: string;
  fullPage?: boolean;
};

type EvaluateAction = ActionBase & {
  type: 'evaluate';
  expression: string;
};

type SetViewportAction = ActionBase & {
  type: 'setViewport';
  width: number;
  height: number;
};

type WaitAction = ActionBase & {
  type: 'wait';
  ms: number;
};

type Action =
  | GotoAction
  | WaitForAction
  | WaitForLoadStateAction
  | ClickAction
  | FillAction
  | PressAction
  | ScreenshotAction
  | EvaluateAction
  | SetViewportAction
  | WaitAction;

type InputPayload = {
  options?: Options;
  actions: Action[];
};

type ActionResult = {
  type: Action['type'];
  ok: true;
  savedAs?: string;
  data?: Record<string, unknown>;
};

type ActionMetaResult = ActionResult & {
  index: number;
  timingMs: number;
};

type OutputPayload = {
  ok: true;
  results: ActionMetaResult[];
  timingMs: number;
  variables?: Record<string, unknown>;
  console?: ConsoleEntry[];
  pageErrors?: PageErrorEntry[];
};

type ErrorPayload = {
  ok: false;
  error: {
    code: ErrorCode;
    name: string;
    message: string;
    stack?: string;
    stepIndex?: number;
    action?: Action;
    tracePath?: string;
    resultsSoFar?: ActionMetaResult[];
    console?: ConsoleEntry[];
    pageErrors?: PageErrorEntry[];
  };
};


type CliArgs = {
  inputPath?: string;
  json?: string;
  outputPath?: string;
  pretty?: boolean;
  debug?: boolean;
  traceOnFailureDir?: string;
  captureConsole?: boolean;
  help?: boolean;
  version?: boolean;
  headlessOverride?: boolean;
};

const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 720 };
const TEMPLATE_REGEX = /\{\{\s*([\w$.-]+)\s*\}\}/g;

const USAGE = `codex-browser

Usage:
  codex-browser --input request.json
  codex-browser --json '{"actions":[...]}'
  cat request.json | codex-browser

Options:
  --input <path>             Read JSON payload from file
  --json <string>            Read JSON payload from inline string
  --output <path>            Write JSON response to file (still prints to stdout)
  --trace-on-failure <dir>   Write Playwright trace zip on failure
  --capture-console          Capture browser console/pageerror into output JSON
  --headed                   Run with a visible browser window
  --headless                 Run without a visible browser window (default)
  --pretty                   Pretty-print JSON output
  --debug                    Include stack traces on errors
  --help                     Show this help
  --version                  Show version
`;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', (err) => reject(err));
  });
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--input':
        if (!argv[i + 1]) {
          throw new CodexBrowserError('INVALID_INPUT', 'Missing value for --input');
        }
        args.inputPath = argv[i + 1];
        i += 1;
        break;
      case '--json':
        if (!argv[i + 1]) {
          throw new CodexBrowserError('INVALID_INPUT', 'Missing value for --json');
        }
        args.json = argv[i + 1];
        i += 1;
        break;
      case '--output':
        if (!argv[i + 1]) {
          throw new CodexBrowserError('INVALID_INPUT', 'Missing value for --output');
        }
        args.outputPath = argv[i + 1];
        i += 1;
        break;
      case '--pretty':
        args.pretty = true;
        break;
      case '--debug':
        args.debug = true;
        break;
      case '--headed':
        if (args.headlessOverride !== undefined && args.headlessOverride !== false) {
          throw new CodexBrowserError('INVALID_INPUT', 'Cannot use --headed and --headless together');
        }
        args.headlessOverride = false;
        break;
      case '--headless':
        if (args.headlessOverride !== undefined && args.headlessOverride !== true) {
          throw new CodexBrowserError('INVALID_INPUT', 'Cannot use --headed and --headless together');
        }
        args.headlessOverride = true;
        break;
      case '--trace-on-failure':
        if (!argv[i + 1]) {
          throw new CodexBrowserError('INVALID_INPUT', 'Missing value for --trace-on-failure');
        }
        args.traceOnFailureDir = argv[i + 1];
        i += 1;
        break;
      case '--capture-console':
        args.captureConsole = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      default:
        throw new CodexBrowserError('INVALID_INPUT', `Unknown argument: ${arg}`);
    }
  }
  return args;
}

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexBrowserError('INVALID_INPUT', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

class CodexBrowserError extends Error {
  public code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'CodexBrowserError';
    this.code = code;
  }
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodexBrowserError('INVALID_INPUT', `${label} must be a non-empty string`);
  }
  return value;
}

function ensureNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new CodexBrowserError('INVALID_INPUT', `${label} must be a number`);
  }
  return value;
}

function ensureOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureNumber(value, label);
}

function ensureOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new CodexBrowserError('INVALID_INPUT', `${label} must be a boolean`);
  }
  return value;
}

function ensureOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureString(value, label);
}

function ensureOptionalSaveAs(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const name = ensureString(value, label);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new CodexBrowserError('INVALID_INPUT', `${label} must use only letters, numbers, underscores, or dashes`);
  }
  return name;
}

function ensureOptionalOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new CodexBrowserError('INVALID_INPUT', `${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function validateViewport(value: unknown, label: string): Viewport {
  const obj = ensureObject(value, label);
  return {
    width: ensureNumber(obj.width, `${label}.width`),
    height: ensureNumber(obj.height, `${label}.height`)
  };
}

function validateOptions(value: unknown): Options | undefined {
  if (value === undefined) {
    return undefined;
  }
  const obj = ensureObject(value, 'options');
  const options: Options = {};

  if (obj.headless !== undefined) {
    options.headless = ensureOptionalBoolean(obj.headless, 'options.headless');
  }

  options.slowMoMs = ensureOptionalNumber(obj.slowMoMs, 'options.slowMoMs');
  options.defaultTimeoutMs = ensureOptionalNumber(obj.defaultTimeoutMs, 'options.defaultTimeoutMs');
  options.defaultNavigationTimeoutMs = ensureOptionalNumber(
    obj.defaultNavigationTimeoutMs,
    'options.defaultNavigationTimeoutMs'
  );

  if (obj.viewport !== undefined) {
    options.viewport = validateViewport(obj.viewport, 'options.viewport');
  }

  options.userAgent = ensureOptionalString(obj.userAgent, 'options.userAgent');
  options.locale = ensureOptionalString(obj.locale, 'options.locale');
  options.timezoneId = ensureOptionalString(obj.timezoneId, 'options.timezoneId');
  options.ignoreHTTPSErrors = ensureOptionalBoolean(
    obj.ignoreHTTPSErrors,
    'options.ignoreHTTPSErrors'
  );

  options.traceOnFailureDir = ensureOptionalString(obj.traceOnFailureDir, 'options.traceOnFailureDir');
  options.captureConsole = ensureOptionalBoolean(obj.captureConsole, 'options.captureConsole');

  return options;
}

function validateAction(value: unknown, index: number): Action {
  const obj = ensureObject(value, `actions[${index}]`);
  const type = ensureString(obj.type, `actions[${index}].type`);
  const saveAs = ensureOptionalSaveAs(obj.saveAs, `actions[${index}].saveAs`);

  switch (type) {
    case 'goto':
      return {
        type: 'goto',
        url: ensureString(obj.url, `actions[${index}].url`),
        waitUntil: ensureOptionalOneOf(obj.waitUntil, ['load', 'domcontentloaded', 'networkidle'], `actions[${index}].waitUntil`),
        timeoutMs: ensureOptionalNumber(obj.timeoutMs, `actions[${index}].timeoutMs`),
        saveAs
      };
    case 'waitFor':
      return {
        type: 'waitFor',
        selector: ensureString(obj.selector, `actions[${index}].selector`),
        state: ensureOptionalOneOf(obj.state, ['attached', 'detached', 'visible', 'hidden'], `actions[${index}].state`),
        timeoutMs: ensureOptionalNumber(obj.timeoutMs, `actions[${index}].timeoutMs`),
        saveAs
      };
    case 'waitForLoadState':
      return {
        type: 'waitForLoadState',
        state: ensureOptionalOneOf(obj.state, ['load', 'domcontentloaded', 'networkidle'], `actions[${index}].state`),
        timeoutMs: ensureOptionalNumber(obj.timeoutMs, `actions[${index}].timeoutMs`),
        saveAs
      };
    case 'click':
      return {
        type: 'click',
        selector: ensureString(obj.selector, `actions[${index}].selector`),
        button: ensureOptionalOneOf(obj.button, ['left', 'right', 'middle'], `actions[${index}].button`),
        clickCount: ensureOptionalNumber(obj.clickCount, `actions[${index}].clickCount`),
        delayMs: ensureOptionalNumber(obj.delayMs, `actions[${index}].delayMs`),
        timeoutMs: ensureOptionalNumber(obj.timeoutMs, `actions[${index}].timeoutMs`),
        saveAs
      };
    case 'fill':
      return {
        type: 'fill',
        selector: ensureString(obj.selector, `actions[${index}].selector`),
        text: ensureString(obj.text, `actions[${index}].text`),
        timeoutMs: ensureOptionalNumber(obj.timeoutMs, `actions[${index}].timeoutMs`),
        saveAs
      };
    case 'press':
      return {
        type: 'press',
        key: ensureString(obj.key, `actions[${index}].key`),
        selector: ensureOptionalString(obj.selector, `actions[${index}].selector`),
        timeoutMs: ensureOptionalNumber(obj.timeoutMs, `actions[${index}].timeoutMs`),
        saveAs
      };
    case 'screenshot':
      return {
        type: 'screenshot',
        path: ensureString(obj.path, `actions[${index}].path`),
        fullPage: ensureOptionalBoolean(obj.fullPage, `actions[${index}].fullPage`),
        saveAs
      };
    case 'evaluate':
      return {
        type: 'evaluate',
        expression: ensureString(obj.expression, `actions[${index}].expression`),
        saveAs
      };
    case 'setViewport':
      return {
        type: 'setViewport',
        width: ensureNumber(obj.width, `actions[${index}].width`),
        height: ensureNumber(obj.height, `actions[${index}].height`),
        saveAs
      };
    case 'wait':
      return {
        type: 'wait',
        ms: ensureNumber(obj.ms, `actions[${index}].ms`),
        saveAs
      };
    default:
       throw new CodexBrowserError('INVALID_INPUT', `actions[${index}].type is unsupported: ${type}`);

  }
}

function parseInput(raw: string): InputPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CodexBrowserError('INVALID_INPUT', `Invalid JSON: ${(err as Error).message}`);
  }
  const obj = ensureObject(parsed, 'input');

  if (!Array.isArray(obj.actions)) {
      throw new CodexBrowserError('INVALID_INPUT', 'actions must be an array');

  }

  const actions = obj.actions.map((action, index) => validateAction(action, index));
  if (actions.length === 0) {
    throw new CodexBrowserError('INVALID_INPUT', 'actions must contain at least one entry');
  }

  const options = validateOptions(obj.options);

  return { actions, options };
}

function inferErrorCode(err: unknown): ErrorCode {
  if (err instanceof CodexBrowserError) {
    return err.code;
  }

  if (err && typeof err === 'object') {
    const anyErr = err as { name?: unknown; message?: unknown };
    const name = typeof anyErr.name === 'string' ? anyErr.name : '';

    if (name === 'TimeoutError') {
      return 'PLAYWRIGHT_TIMEOUT';
    }

    if (name.toLowerCase().includes('playwright')) {
      return 'PLAYWRIGHT_ERROR';
    }
  }

  return 'UNKNOWN';
}

function extractErrorPayload(err: unknown): ErrorPayload | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  const record = err as { ok?: unknown; error?: unknown };
  if (record.ok !== false || !record.error || typeof record.error !== 'object') {
    return undefined;
  }
  const errorObj = record.error as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof errorObj.code !== 'string' || typeof errorObj.name !== 'string' || typeof errorObj.message !== 'string') {
    return undefined;
  }
  return err as ErrorPayload;
}

function serializeError(
  err: unknown,
  includeStack: boolean,
  extras?: {
    code?: ErrorCode;
    stepIndex?: number;
    action?: Action;
    tracePath?: string;
    resultsSoFar?: ActionMetaResult[];
    console?: ConsoleEntry[];
    pageErrors?: PageErrorEntry[];
  }
): ErrorPayload {
  const error = err instanceof Error ? err : new Error(String(err));
  return {
    ok: false,
    error: {
      code: extras?.code ?? inferErrorCode(err),
      name: error.name,
      message: error.message,
      stack: includeStack ? error.stack : undefined,
      stepIndex: extras?.stepIndex,
      action: extras?.action,
      tracePath: extras?.tracePath,
      resultsSoFar: extras?.resultsSoFar,
      console: extras?.console,
      pageErrors: extras?.pageErrors
    }
  };
}

function readVarPath(value: unknown, pathParts: string[], pathLabel: string): unknown {
  let current = value;
  for (const part of pathParts) {
    if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, part)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      throw new CodexBrowserError('TEMPLATE_ERROR', `Template path not found: ${pathLabel}`);
    }
  }
  return current;
}

function resolveTemplate(value: string, vars: Record<string, unknown>): string {
  if (!value.includes('{{')) {
    return value;
  }
  return value.replace(TEMPLATE_REGEX, (_match, rawPath: string) => {
    const pathParts = rawPath.split('.').filter(Boolean);
    if (pathParts.length === 0) {
      throw new CodexBrowserError('TEMPLATE_ERROR', 'Template path cannot be empty');
    }
    const resolved = readVarPath(vars, pathParts, rawPath);
    if (resolved === null || resolved === undefined) {
      throw new CodexBrowserError('TEMPLATE_ERROR', `Template path resolves to empty value: ${rawPath}`);
    }
    if (typeof resolved === 'object') {
      throw new CodexBrowserError('TEMPLATE_ERROR', `Template path resolves to a non-primitive: ${rawPath}`);
    }
    return String(resolved);
  });
}

function resolveActionTemplates(action: Action, vars: Record<string, unknown>): Action {
  switch (action.type) {
    case 'goto':
      return { ...action, url: resolveTemplate(action.url, vars) };
    case 'waitFor':
      return { ...action, selector: resolveTemplate(action.selector, vars) };
    case 'click':
      return { ...action, selector: resolveTemplate(action.selector, vars) };
    case 'fill':
      return {
        ...action,
        selector: resolveTemplate(action.selector, vars),
        text: resolveTemplate(action.text, vars)
      };
    case 'press':
      return {
        ...action,
        key: resolveTemplate(action.key, vars),
        selector: action.selector ? resolveTemplate(action.selector, vars) : undefined
      };
    case 'screenshot':
      return { ...action, path: resolveTemplate(action.path, vars) };
    case 'evaluate':
      return { ...action, expression: resolveTemplate(action.expression, vars) };
    case 'setViewport':
    case 'wait':
      return action;
    default:
      return action;
  }
}

function getSavedValue(action: Action, result: ActionResult): unknown {
  if (!result.data) {
    return undefined;
  }
  if (action.type === 'evaluate') {
    return result.data.result;
  }
  return result.data;
}

async function runAction(page: Page, action: Action, cwd: string): Promise<ActionResult> {
  switch (action.type) {
    case 'goto': {
      const response = await page.goto(action.url, {
        waitUntil: action.waitUntil,
        timeout: action.timeoutMs
      });
      return {
        type: action.type,
        ok: true,
        data: {
          url: page.url(),
          status: response?.status() ?? null
        }
      };
    }
    case 'waitFor': {
      await page.waitForSelector(action.selector, {
        state: action.state,
        timeout: action.timeoutMs
      });
      return {
        type: action.type,
        ok: true,
        data: {
          selector: action.selector,
          state: action.state ?? 'visible'
        }
      };
    }
    case 'waitForLoadState': {
      await page.waitForLoadState(action.state, { timeout: action.timeoutMs });
      return {
        type: action.type,
        ok: true,
        data: {
          state: action.state ?? 'load'
        }
      };
    }
    case 'click': {
      await page.click(action.selector, {
        button: action.button,
        clickCount: action.clickCount,
        delay: action.delayMs,
        timeout: action.timeoutMs
      });
      return { type: action.type, ok: true, data: { selector: action.selector } };
    }
    case 'fill': {
      await page.fill(action.selector, action.text, { timeout: action.timeoutMs });
      return { type: action.type, ok: true, data: { selector: action.selector } };
    }
    case 'press': {
      if (action.selector) {
        await page.press(action.selector, action.key, { timeout: action.timeoutMs });
      } else {
        await page.keyboard.press(action.key);
      }
      return { type: action.type, ok: true, data: { key: action.key } };
    }
    case 'screenshot': {
      const targetPath = path.resolve(cwd, action.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await page.screenshot({ path: targetPath, fullPage: action.fullPage ?? false });
      return { type: action.type, ok: true, data: { path: targetPath } };
    }
    case 'evaluate': {
      const result = await page.evaluate(action.expression);
      return { type: action.type, ok: true, data: { result } };
    }
    case 'setViewport': {
      await page.setViewportSize({ width: action.width, height: action.height });
      return { type: action.type, ok: true, data: { width: action.width, height: action.height } };
    }
    case 'wait': {
      await page.waitForTimeout(action.ms);
      return { type: action.type, ok: true, data: { ms: action.ms } };
    }
    default:
      throw new CodexBrowserError('INVALID_INPUT', `Unsupported action: ${(action as Action).type}`);
  }
}

async function runBrowser(payload: InputPayload, includeStack: boolean): Promise<OutputPayload> {
  const start = Date.now();
  const options = payload.options ?? {};
  const browser: Browser = await chromium.launch({
    headless: options.headless ?? true,
    slowMo: options.slowMoMs
  });

  const consoleEntries: ConsoleEntry[] = [];
  const pageErrors: PageErrorEntry[] = [];

  let interrupted = false;

  try {
    const context = await browser.newContext({
      viewport: options.viewport ?? DEFAULT_VIEWPORT,
      userAgent: options.userAgent,
      locale: options.locale,
      timezoneId: options.timezoneId,
      ignoreHTTPSErrors: options.ignoreHTTPSErrors
    });

    const shouldTrace = Boolean(options.traceOnFailureDir);
    if (shouldTrace) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }

    const page = await context.newPage();
    if (options.captureConsole) {
      page.on('console', (msg) => {
        consoleEntries.push({ type: msg.type(), text: msg.text(), location: msg.location() });
      });
      page.on('pageerror', (err) => {
        pageErrors.push({ message: err.message, stack: err.stack });
      });
    }

    if (options.defaultTimeoutMs !== undefined) {
      page.setDefaultTimeout(options.defaultTimeoutMs);
    }
    if (options.defaultNavigationTimeoutMs !== undefined) {
      page.setDefaultNavigationTimeout(options.defaultNavigationTimeoutMs);
    }

    const results: ActionMetaResult[] = [];
    const cwd = process.cwd();

    const vars: Record<string, unknown> = {};

    const stopTracing = async (tracePath?: string): Promise<void> => {
      if (!shouldTrace) {
        return;
      }
      if (tracePath) {
        await fs.mkdir(path.dirname(tracePath), { recursive: true });
        await context.tracing.stop({ path: tracePath });
      } else {
        await context.tracing.stop();
      }
    };

    let currentActionIndex = -1;
    let currentResolvedAction: Action | undefined;

    const onSignal = (): void => {
      interrupted = true;
      void browser.close();
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
      for (let index = 0; index < payload.actions.length; index += 1) {
        if (interrupted) {
          throw new CodexBrowserError('INTERRUPTED', 'Interrupted');
        }

        currentActionIndex = index;
        const action = payload.actions[index];
        currentResolvedAction = resolveActionTemplates(action, vars);

        const actionStart = Date.now();
        const result = await runAction(page, currentResolvedAction, cwd);
        const actionTimingMs = Date.now() - actionStart;

        if (action.saveAs) {
          vars[action.saveAs] = getSavedValue(currentResolvedAction, result);
          result.savedAs = action.saveAs;
        }

        results.push({ ...result, index, timingMs: actionTimingMs });
      }

      await stopTracing();

      const outputPayload: OutputPayload = {
        ok: true,
        results,
        timingMs: Date.now() - start
      };
      if (Object.keys(vars).length > 0) {
        outputPayload.variables = vars;
      }
      if (options.captureConsole && consoleEntries.length > 0) {
        outputPayload.console = consoleEntries;
      }
      if (options.captureConsole && pageErrors.length > 0) {
        outputPayload.pageErrors = pageErrors;
      }
      return outputPayload;
    } catch (err) {
      let tracePath: string | undefined;
      if (shouldTrace && options.traceOnFailureDir) {
        tracePath = path.resolve(
          process.cwd(),
          options.traceOnFailureDir,
          `trace-failure-${process.pid}-${Date.now()}.zip`
        );
        await stopTracing(tracePath);
      }

      const errorCode: ErrorCode = inferErrorCode(err);

      throw serializeError(err, includeStack, {
        code: errorCode,
        stepIndex: currentActionIndex >= 0 ? currentActionIndex : undefined,
        action: currentResolvedAction,
        tracePath,
        resultsSoFar: results,
        console: options.captureConsole && consoleEntries.length > 0 ? consoleEntries : undefined,
        pageErrors: options.captureConsole && pageErrors.length > 0 ? pageErrors : undefined
      });
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  } finally {
    await browser.close();
  }
}

async function writeOutput(
  payload: OutputPayload | ErrorPayload,
  outputPath: string | undefined,
  pretty: boolean
): Promise<void> {
  const json = JSON.stringify(payload, null, pretty ? 2 : 0) + '\n';
  if (outputPath) {
    const targetPath = path.resolve(process.cwd(), outputPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, json, 'utf8');
  }
  process.stdout.write(json);
}

async function loadInput(args: CliArgs): Promise<InputPayload> {
  let raw = '';
  if (args.json) {
    raw = args.json;
  } else if (args.inputPath) {
    const targetPath = path.resolve(process.cwd(), args.inputPath);
    raw = await fs.readFile(targetPath, 'utf8');
  } else if (!process.stdin.isTTY) {
    raw = await readStdin();
  } else {
    throw new CodexBrowserError('INVALID_INPUT', 'No input provided. Use --json, --input, or pipe JSON via stdin.');
  }

  if (raw.trim().length === 0) {
    throw new CodexBrowserError('INVALID_INPUT', 'No input provided. Use --json, --input, or pipe JSON via stdin.');
  }

  return parseInput(raw);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.version) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../package.json') as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  try {
    const payload = await loadInput(args);

    payload.options = {
      ...payload.options,
      traceOnFailureDir: args.traceOnFailureDir ?? payload.options?.traceOnFailureDir,
      captureConsole: args.captureConsole ?? payload.options?.captureConsole
    };

    if (args.headlessOverride !== undefined) {
      payload.options = { ...payload.options, headless: args.headlessOverride };
    }

    const output = await runBrowser(payload, args.debug ?? false);
    await writeOutput(output, args.outputPath, args.pretty ?? false);
  } catch (err) {
    const errorPayload = extractErrorPayload(err) ?? serializeError(err, args.debug ?? false);
    await writeOutput(errorPayload, args.outputPath, args.pretty ?? false);
    process.exitCode = 1;
  }
}

void main();
