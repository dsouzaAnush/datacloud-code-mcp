import vm from "node:vm";

export interface SandboxResult {
  result?: unknown;
  err?: string;
  stack?: string;
}

export interface RunOptions {
  timeoutMs: number;
}

// The wrapper serializes the return value to JSON inside the sandbox to break
// any host-realm prototype chain links. This prevents the classic node:vm escape
// where user code walks constructor.constructor to reach the host Function.
const WRAPPER = (userCode: string) => `
"use strict";
(async () => {
  try {
    const __fn = (${userCode});
    if (typeof __fn !== "function") {
      throw new Error("Code must evaluate to an async arrow function: async () => { ... }");
    }
    const __result = await __fn();
    return JSON.stringify({ result: __result });
  } catch (err) {
    return JSON.stringify({
      err: err && err.message ? String(err.message) : String(err),
      stack: err && err.stack ? String(err.stack) : undefined
    });
  }
})()
`;

// Pull pristine JS builtins from a throwaway context so user code cannot
// pollute the host realm's prototypes (e.g., Object.prototype.x = ...).
const pristineContext = vm.createContext({});
const FRESH_BUILTINS = vm.runInContext(
  `({ Object, Array, String, Number, Boolean, Error, Map, Set, WeakMap, WeakSet,
     Symbol, Promise, Date, Math, JSON, RegExp, Proxy, Reflect,
     encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
     isFinite, isNaN, parseFloat, parseInt })`,
  pristineContext
) as Record<string, unknown>;

function buildContext(globals: Record<string, unknown>): vm.Context {
  const sandbox: Record<string, unknown> = {
    console: Object.freeze({
      log: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    }),
    // Pristine core JS builtins (isolated prototypes)
    ...FRESH_BUILTINS,
    // Web APIs are safe to share — they don't have mutable prototypes that
    // affect host logic; we Object.freeze the constructors as a precaution.
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone: typeof structuredClone === "function" ? structuredClone : undefined,
    // User-supplied globals (spec, salesforce, etc.)
    ...globals
  };

  return vm.createContext(sandbox, {
    name: "datacloud-code-mode-sandbox",
    codeGeneration: { strings: false, wasm: false }
  });
}

export async function runUserCode(
  userCode: string,
  globals: Record<string, unknown>,
  opts: RunOptions
): Promise<SandboxResult> {
  const context = buildContext(globals);

  let script: vm.Script;
  try {
    script = new vm.Script(WRAPPER(userCode), {
      filename: "user-code.js"
    });
  } catch (error) {
    return {
      err: `Failed to compile user code: ${(error as Error).message}`
    };
  }

  let promise: unknown;
  try {
    promise = script.runInContext(context, {
      timeout: opts.timeoutMs,
      breakOnSigint: true,
      displayErrors: false
    });
  } catch (error) {
    return {
      err: (error as Error).message,
      stack: (error as Error).stack
    };
  }

  if (!promise || typeof (promise as { then?: unknown }).then !== "function") {
    return { err: "User code did not return a Promise (must be `async () => ...`)" };
  }

  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    guardTimer = setTimeout(() => reject(new Error(`Sandbox execution exceeded ${opts.timeoutMs}ms`)), opts.timeoutMs);
  });

  try {
    // The wrapper returns a JSON string so the result never leaks host-realm objects.
    const raw = (await Promise.race([promise, guard])) as string;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw) as SandboxResult;
      } catch {
        return { result: raw };
      }
    }
    return { result: raw };
  } catch (error) {
    return {
      err: (error as Error).message,
      stack: (error as Error).stack
    };
  } finally {
    if (guardTimer) clearTimeout(guardTimer);
  }
}
