import http from 'node:http';

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const PREFLIGHT_TIMEOUT_MS = 3_000;
const NON_CHAT_MODEL_PATTERN = /embed|embedding|bge|nomic|clip/i;

export interface OllamaModelOption {
  displayName: string;
  id: string;
}

export class OllamaClientError extends Error {
  constructor(
    message: string,
    public readonly code: 'connection_failed' | 'http_error' | 'invalid_response' | 'timeout',
  ) {
    super(message);
    this.name = 'OllamaClientError';
  }
}

export interface OllamaClient {
  listOllamaModels(): Promise<OllamaModelOption[]>;
  prewarmModel(modelId: string): Promise<void>;
  probeOllama(): Promise<void>;
}

export function createOllamaClient(): OllamaClient {
  return {
    listOllamaModels,
    prewarmModel,
    probeOllama,
  };
}

export async function probeOllama(): Promise<void> {
  const response = await requestJson('GET', '/api/version');

  if (!isRecord(response) || typeof response.version !== 'string') {
    throw new OllamaClientError('Ollama returned an invalid version response.', 'invalid_response');
  }
}

export async function listOllamaModels(): Promise<OllamaModelOption[]> {
  const response = await requestJson('GET', '/api/tags');

  if (!isRecord(response) || !Array.isArray(response.models)) {
    throw new OllamaClientError('Ollama returned an invalid model list.', 'invalid_response');
  }

  return response.models
    .map((entry): OllamaModelOption => {
      if (!isRecord(entry) || typeof entry.model !== 'string' || typeof entry.name !== 'string') {
        throw new OllamaClientError('Ollama returned an invalid model entry.', 'invalid_response');
      }

      return { displayName: entry.name, id: entry.model };
    })
    .filter((model) => !NON_CHAT_MODEL_PATTERN.test(model.displayName))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function prewarmModel(modelId: string): Promise<void> {
  try {
    await requestJson('POST', '/api/chat', {
      keep_alive: '30m',
      messages: [{ content: 'ok', role: 'user' }],
      model: modelId,
      options: { num_predict: 1 },
      stream: false,
    });
  } catch {
    // Best effort only; enabling the feature should not depend on pre-warm.
  }
}

async function requestJson(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const responseText = await requestText(method, path, body);

  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new OllamaClientError(
      `Ollama returned malformed JSON: ${String(error)}`,
      'invalid_response',
    );
  }
}

function requestText(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        headers:
          requestBody === undefined
            ? undefined
            : {
                'content-length': Buffer.byteLength(requestBody).toString(),
                'content-type': 'application/json',
              },
        host: OLLAMA_HOST,
        method,
        path,
        port: OLLAMA_PORT,
        timeout: PREFLIGHT_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new OllamaClientError(`Ollama returned HTTP ${statusCode}.`, 'http_error'));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new OllamaClientError('Ollama request timed out.', 'timeout'));
    });
    request.on('error', (error) => {
      reject(
        error instanceof OllamaClientError
          ? error
          : new OllamaClientError(`Failed to reach Ollama: ${error.message}`, 'connection_failed'),
      );
    });

    if (requestBody !== undefined) {
      request.write(requestBody);
    }
    request.end();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
