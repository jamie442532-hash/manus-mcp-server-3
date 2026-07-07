/**
 * Thin client for the Manus API task lifecycle.
 *
 * Manus does not expose a dedicated "image generation" endpoint — it exposes
 * a general task API. You create a task with a natural-language prompt,
 * poll it until it completes, then read the output files it produced.
 *
 * IMPORTANT: Confirm the exact paths/response shape against your Manus API
 * dashboard/docs (https://manus.im/docs/integrations/manus-api) — endpoint
 * names can differ slightly by account/version. The constants below are
 * isolated at the top so you can adjust them in one place if needed.
 */

const MANUS_API_BASE = process.env.MANUS_API_BASE_URL ?? "https://api.manus.im/v1";
const MANUS_API_KEY = process.env.MANUS_API_KEY;

if (!MANUS_API_KEY) {
  console.warn(
    "[manusClient] WARNING: MANUS_API_KEY is not set. Set it in Railway variables."
  );
}

const CREATE_TASK_PATH = "/tasks";
const GET_TASK_PATH = (taskId: string) => `/tasks/${taskId}`;

export interface ManusTaskResult {
  taskId: string;
  status: string;
  files: { name: string; url: string }[];
  rawText?: string;
}

async function manusFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${MANUS_API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MANUS_API_KEY}`,
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Manus API error ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Creates a Manus task that asks the agent to generate an image and
 * return it as a downloadable file.
 */
export async function createImageTask(params: {
  prompt: string;
  style?: string;
  aspectRatio?: string;
  agentProfile?: string;
}): Promise<string> {
  const { prompt, style, aspectRatio, agentProfile } = params;

  const instruction = [
    `Generate an image with the following description: ${prompt}.`,
    style ? `Style: ${style}.` : "",
    aspectRatio ? `Aspect ratio: ${aspectRatio}.` : "",
    "Return the final image as a downloadable file. Do not include extra commentary, just produce the image.",
  ]
    .filter(Boolean)
    .join(" ");

  const body: Record<string, unknown> = {
    prompt: instruction,
  };
  if (agentProfile) body.agentProfile = agentProfile;

  const data = (await manusFetch(CREATE_TASK_PATH, {
    method: "POST",
    body: JSON.stringify(body),
  })) as { task_id?: string; id?: string };

  const taskId = data.task_id ?? data.id;
  if (!taskId) {
    throw new Error(
      `Unexpected Manus create-task response shape: ${JSON.stringify(data)}`
    );
  }
  return taskId;
}

export async function getTask(taskId: string): Promise<ManusTaskResult> {
  const data = (await manusFetch(GET_TASK_PATH(taskId))) as any;

  const status: string = data.status ?? data.state ?? "unknown";

  const rawFiles: any[] = data.files ?? data.output_files ?? data.attachments ?? [];
  const files = rawFiles
    .map((f) => ({
      name: f.name ?? f.filename ?? "output",
      url: f.url ?? f.download_url ?? f.href,
    }))
    .filter((f) => !!f.url);

  return {
    taskId,
    status,
    files,
    rawText: data.result_text ?? data.summary,
  };
}

const TERMINAL_STATUSES = ["completed", "success", "succeeded", "failed", "error", "cancelled"];

/**
 * Polls a Manus task until it reaches a terminal state or the timeout elapses.
 */
export async function pollTaskUntilDone(
  taskId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<ManusTaskResult> {
  const intervalMs = opts.intervalMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 240_000; // 4 minutes default ceiling
  const start = Date.now();

  while (true) {
    const result = await getTask(taskId);

    if (TERMINAL_STATUSES.includes(result.status.toLowerCase())) {
      return result;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for Manus task ${taskId} to complete (last status: ${result.status})`
      );
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
