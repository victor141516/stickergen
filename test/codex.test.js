import assert from "node:assert/strict";
import test from "node:test";
import { generateStickerImage } from "../src/codex.js";

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
    prompt: "un gato astronauta",
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
    prompt: "un perro con sombrero",
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
    }),
    /events: response.completed; response status: completed/,
  );
});
