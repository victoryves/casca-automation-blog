interface GeminiTextOptions {
  systemInstruction?: string;
  userPrompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  model?: string;
  responseMimeType?: string;
}

interface GeminiImageOptions {
  systemInstruction?: string;
  prompt: string;
  imageBase64: string;
  mimeType: string;
  maxOutputTokens?: number;
  temperature?: number;
  model?: string;
  responseMimeType?: string;
}

interface GeminiCandidatePart {
  text?: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiCandidatePart[];
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
  error?: {
    message?: string;
    status?: string;
  };
}

export class GeminiClient {
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel = 'gemini-2.5-flash'
  ) {}

  async generateText(options: GeminiTextOptions): Promise<string> {
    const response = await this.request(options.model, {
      systemInstruction: options.systemInstruction
        ? {
            parts: [{ text: options.systemInstruction }],
          }
        : undefined,
      contents: [
        {
          role: 'user',
          parts: [{ text: options.userPrompt }],
        },
      ],
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxOutputTokens ?? 4096,
        responseMimeType: options.responseMimeType,
      },
    });

    return this.extractText(response);
  }

  async generateTextFromImage(options: GeminiImageOptions): Promise<string> {
    const response = await this.request(options.model, {
      systemInstruction: options.systemInstruction
        ? {
            parts: [{ text: options.systemInstruction }],
          }
        : undefined,
      contents: [
        {
          role: 'user',
          parts: [
            { text: options.prompt },
            {
              inlineData: {
                mimeType: options.mimeType,
                data: options.imageBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: options.temperature ?? 0,
        maxOutputTokens: options.maxOutputTokens ?? 512,
        responseMimeType: options.responseMimeType,
      },
    });

    return this.extractText(response);
  }

  private async request(model: string | undefined, body: Record<string, unknown>): Promise<GeminiResponse> {
    const targetModel = model || this.defaultModel;
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    const json = (await response.json()) as GeminiResponse;

    if (!response.ok) {
      const message = json.error?.message || `Gemini API request failed with status ${response.status}`;
      throw new Error(message);
    }

    if (json.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request: ${json.promptFeedback.blockReason}`);
    }

    return json;
  }

  private extractText(response: GeminiResponse): string {
    const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();

    if (!text) {
      const finishReason = response.candidates?.[0]?.finishReason;
      throw new Error(finishReason ? `Empty Gemini response (${finishReason})` : 'Empty Gemini response');
    }

    return text;
  }
}
