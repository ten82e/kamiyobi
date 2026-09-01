/** Required tests must stub discovery HTTP explicitly; live checks are outside the test suite. */
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`network access is disabled in required tests: ${String(input)}`);
}) as typeof fetch;
