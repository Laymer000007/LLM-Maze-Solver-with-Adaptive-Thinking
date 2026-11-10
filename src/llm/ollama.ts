import type { LLMConfig } from '@/llm/config';

type ChatReply = { text: string; raw: Record<string, unknown> };

/** The only AI client: posts ready-made /api/chat bodies to Ollama. */
export class OllamaClient {
  constructor(private readonly config: LLMConfig) {}

  async chat(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatReply> {
    const response = await fetch(`${this.config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`Ollama request failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
    const raw = (await response.json()) as { message?: { content?: string } } & Record<string, unknown>;
    return { text: raw.message?.content ?? '', raw };
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.config.baseUrl}/api/tags`);
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}.`);
    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((model) => model.name).filter((name): name is string => Boolean(name));
  }

  async testConnection(): Promise<string> {
    const models = await this.listModels().catch(() => {
      throw new Error(`Could not connect to Ollama at ${this.config.baseUrl}.`);
    });
    return models.includes(this.config.model)
      ? `Connected to Ollama. Model ${this.config.model} is available.`
      : `Connected to Ollama, but model ${this.config.model} was not found.`;
  }
}
