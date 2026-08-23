import assert from "node:assert/strict";
import test from "node:test";
import { generateStickerImage } from "../src/codex.js";

const silentLogger = { error() {} };

test("Codex image request uses streaming and extracts the completed image", async () => {
  const expected = "A".repeat(120);
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const event = {
      type: "response.output_item.done",
      item: { type: "image_generation_call", result: expected },
    };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const result = await generateStickerImage({
    oauth: { accessToken: "test-token", accountId: "account-1" },
    prompt: "an astronaut cat",
    fetchImpl,
  });

  assert.equal(requestBody.stream, true);
  assert.deepEqual(requestBody.tools, [{ type: "image_generation" }]);
  assert.equal(result, expected);
});

test("Codex image edits use the tool controls supported by gpt-image-2-codex", async () => {
  const expected = "C".repeat(120);
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const event = {
      type: "response.output_item.done",
      item: { type: "image_generation_call", result: expected },
    };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  await generateStickerImage({
    oauth: { accessToken: "test-token", accountId: "account-1" },
    prompt: "turn it into a sticker",
    sourceDataUrl: "data:image/png;base64,AAAA",
    fetchImpl,
  });

  assert.deepEqual(requestBody.tools, [{ type: "image_generation" }]);
});

test("Codex parser accepts SSE even when the response content type says JSON", async () => {
  const expected = "B".repeat(120);
  const fetchImpl = async () => {
    const event = {
      type: "response.output_item.done",
      item: { type: "image_generation_call", result: expected },
    };
    return new Response(`event: response.output_item.done\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await generateStickerImage({
    oauth: { accessToken: "test-token", accountId: "account-1" },
    prompt: "a dog wearing a hat",
    fetchImpl,
  });

  assert.equal(result, expected);
});

test("Codex parser surfaces a root-level streaming error message", async () => {
  const fetchImpl = async () => new Response(
    `data: ${JSON.stringify({ type: "error", code: "image_failed", message: "The image edit could not be completed" })}\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

  await assert.rejects(
    generateStickerImage({
      oauth: { accessToken: "test-token", accountId: "account-1" },
      prompt: "remove the background",
      fetchImpl,
      logger: silentLogger,
    }),
    /The image edit could not be completed/,
  );
});

test("Codex parser surfaces failed image generation tool calls", async () => {
  const event = {
    type: "response.output_item.done",
    item: {
      type: "image_generation_call",
      status: "failed",
      error: { message: "Input image was rejected" },
    },
  };
  const fetchImpl = async () => new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

  await assert.rejects(
    generateStickerImage({
      oauth: { accessToken: "test-token", accountId: "account-1" },
      prompt: "remove the background",
      fetchImpl,
      logger: silentLogger,
    }),
    /Codex image generation failed: Input image was rejected/,
  );
});

test("Codex parser keeps reading after a failed image item to capture the terminal reason", async () => {
  const failedItem = {
    type: "response.output_item.done",
    item: { type: "image_generation_call", status: "failed" },
  };
  const failedResponse = {
    type: "response.failed",
    response: {
      status: "failed",
      error: { code: "image_safety_error", message: "The input image could not be processed safely" },
    },
  };
  const fetchImpl = async () => new Response(
    `data: ${JSON.stringify(failedItem)}\n\ndata: ${JSON.stringify(failedResponse)}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

  await assert.rejects(
    generateStickerImage({
      oauth: { accessToken: "test-token", accountId: "account-1" },
      prompt: "remove the background",
      fetchImpl,
      logger: silentLogger,
    }),
    /The input image could not be processed safely/,
  );
});

test("Codex parser reports incomplete responses and safe terminal diagnostics", async () => {
  const incompleteFetch = async () => new Response(`data: ${JSON.stringify({
    type: "response.incomplete",
    response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
  })}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  await assert.rejects(
    generateStickerImage({
      oauth: { accessToken: "test-token", accountId: "account-1" },
      prompt: "make a sticker",
      fetchImpl: incompleteFetch,
      logger: silentLogger,
    }),
    /Codex returned an incomplete response: max_output_tokens/,
  );

  const emptyFetch = async () => new Response(`data: ${JSON.stringify({
    type: "response.completed",
    response: { status: "completed", output: [] },
  })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  await assert.rejects(
    generateStickerImage({
      oauth: { accessToken: "test-token", accountId: "account-1" },
      prompt: "make a sticker",
      fetchImpl: emptyFetch,
      logger: silentLogger,
    }),
    /events: response.completed; response status: completed/,
  );
});

test("failed Codex requests log the complete sanitized request and event trace", async () => {
  const logs = [];
  const privateImageData = "PRIVATE_IMAGE_BYTES".repeat(20);
  const failedItem = {
    type: "response.output_item.done",
    item: { type: "image_generation_call", status: "failed" },
  };
  const outputText = {
    type: "response.output_text.done",
    item_id: "message-1",
    text: "The image tool failed before producing an output.",
  };
  const completed = {
    type: "response.completed",
    response: { status: "completed", output: [failedItem.item] },
  };
  const fetchImpl = async () => new Response(
    [failedItem, outputText, completed]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "x-request-id": "upstream-request-1",
      },
    },
  );
  const logger = {
    error(eventName, payload) {
      logs.push({ eventName, payload: JSON.parse(payload) });
    },
  };

  await assert.rejects(
    generateStickerImage({
      oauth: { accessToken: "PRIVATE_ACCESS_TOKEN", accountId: "account-1" },
      prompt: "remove the background",
      sourceDataUrl: `data:image/webp;base64,${privateImageData}`,
      fetchImpl,
      logger,
    }),
    /The image tool failed before producing an output/,
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].eventName, "codex_request_failed_trace");
  const trace = logs[0].payload;
  assert.equal(trace.request.body.input[0].content[0].text, "remove the background");
  assert.equal(trace.request.body.input[0].content[1].image_url.redacted, "image data");
  assert.equal(trace.request.body.input[0].content[1].image_url.mediaType, "image/webp");
  assert.equal(trace.request.headers.authorization.redacted, "bearer token");
  assert.equal(trace.request.headers["chatgpt-account-id"].redacted, "account identifier");
  assert.equal(trace.response.headers["x-request-id"], "upstream-request-1");
  assert.deepEqual(
    trace.response.events.map((event) => event.type),
    ["response.output_item.done", "response.output_text.done", "response.completed"],
  );
  const serializedTrace = JSON.stringify(trace);
  assert.equal(serializedTrace.includes(privateImageData), false);
  assert.equal(serializedTrace.includes("PRIVATE_ACCESS_TOKEN"), false);
});
