import { writeFileSync } from "node:fs";
import { env } from "@huggingface/transformers";

const originalFetch = env.fetch;
let interrupted = false;
env.fetch = async (input, options) => {
  const url = String(input instanceof Request ? input.url : input);
  const weight = new URL(url).pathname.endsWith("/onnx/model.onnx");
  if (interrupted && weight)
    throw new TypeError("injected connection remains unavailable for this preparation attempt");
  const response = await originalFetch(input, options);
  if (interrupted && weight) {
    void response.body?.cancel();
    throw new TypeError("injected connection remains unavailable");
  }
  const total = Number(response.headers.get("content-length"));
  if (!weight || response.status !== 200 || total < 8 * 1024 * 1024) return response;
  const reader = response.body.getReader();
  let received = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (interrupted || received >= 4 * 1024 * 1024) {
          if (!interrupted)
            writeFileSync(
              process.env.KAMIYOBI_INTERRUPTION_LOG,
              JSON.stringify({ url, received, total }),
            );
          interrupted = true;
          controller.error(new TypeError("injected connection loss during actual model transfer"));
          await reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        received += value.byteLength;
        controller.enqueue(value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
};
