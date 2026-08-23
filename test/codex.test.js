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
    prompt: "hazlo sticker",
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
