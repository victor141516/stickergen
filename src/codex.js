import { randomUUID } from "node:crypto";

const DEFAULT_URL = "https://chatgpt.com/backend-api/codex/responses";

function imageValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.result || value.image_base64 || value.b64_json || value.url || value.image?.url || value.image?.b64_json || null;
}

function collectImageFromOutput(output) {
  for (const item of output || []) {
    if (item?.type === "image_generation_call") {
      const value = imageValue(item);
      if (value) return value;
    }
    if (item?.type === "output_image" && (item.image_base64 || item.b64_json || item.url)) {
      return item.image_base64 || item.b64_json || item.url;
    }
  }
  return null;
}

function findImageInEvent(event) {
  const candidates = [
    event?.image,
    event?.result,
    event?.image_base64,
    event?.b64_json,
    event?.url,
    event?.response?.output && collectImageFromOutput(event.response.output),
    event?.item && collectImageFromOutput([event.item]),
    event?.output_item && collectImageFromOutput([event.output_item]),
  ];
  return candidates.find((value) => typeof value === "string" && value.length > 100) || null;
}

function parseSseFrame(frame) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return { image: null };

  let event;
  try {
    event = JSON.parse(data);
  } catch {
    throw new Error("Codex devolvió un evento SSE no válido");
  }
  if (event.type === "response.failed" || event.type === "error") {
    throw new Error(event.response?.error?.message || event.error?.message || "Codex no pudo generar el sticker");
  }
  return { image: findImageInEvent(event) };
}

function parseSseDocument(text) {
  let image = null;
  const frames = text.replace(/\r\n/g, "\n").split("\n\n");
  for (const frame of frames) {
    if (!frame.trim()) continue;
    image = parseSseFrame(frame).image || image;
  }
  if (!image) throw new Error("Codex no devolvió una imagen");
  return image;
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    if (/^\s*(?:event|data):/i.test(text)) return parseSseDocument(text);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("Codex devolvió una respuesta que no es JSON ni SSE");
    }
    const image = collectImageFromOutput(body.output) || collectImageFromOutput(body.data) || imageValue(body) || findImageInEvent(body);
    if (!image) throw new Error("Codex no devolvió una imagen");
    return image;
  }
  if (!response.body) throw new Error("Codex devolvió un stream vacío");
  const decoder = new TextDecoder();
  let buffer = "";
  let image = null;

  const processFrame = (frame) => {
    image = parseSseFrame(frame).image || image;
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      processFrame(frame);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) processFrame(buffer);
  if (!image) throw new Error("Codex no devolvió una imagen");
  return image;
}

function imageInput(prompt, sourceDataUrl) {
  const content = [{ type: "input_text", text: prompt }];
  if (sourceDataUrl) content.push({ type: "input_image", image_url: sourceDataUrl });
  return [{ type: "message", role: "user", content }];
}

function requestPayload(prompt, sourceDataUrl, model) {
  const sessionId = randomUUID();
  return {
    model,
    instructions: "Create a single Telegram sticker image. Follow the user's requested subject, style, and background. If the user requests transparency, use genuine alpha pixels rather than drawing a gray-and-white checkerboard or transparency preview. Do not add a border or text unless the user explicitly asks for it. Return only the generated image.",
    input: imageInput(prompt, sourceDataUrl),
    // gpt-image-2-codex currently rejects background/input_fidelity controls,
    // so transparency can only be requested semantically.
    tools: [{ type: "image_generation" }],
    tool_choice: "required",
    parallel_tool_calls: false,
    store: false,
    stream: true,
    client_metadata: { session_id: sessionId },
  };
}

export async function generateStickerImage({ oauth, prompt, sourceDataUrl, fetchImpl = fetch }) {
  const url = process.env.CODEX_RESPONSES_URL || DEFAULT_URL;
  const model = process.env.CODEX_MODEL || "gpt-5.6-sol";
  const sessionId = randomUUID();
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${oauth.accessToken}`,
      "ChatGPT-Account-Id": oauth.accountId,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      originator: "telegram-sticker-bot",
      "session-id": sessionId,
      "User-Agent": "telegram-sticker-bot/0.1",
    },
    body: JSON.stringify(requestPayload(prompt, sourceDataUrl, model)),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Codex rechazó la generación (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return parseResponse(response);
}
