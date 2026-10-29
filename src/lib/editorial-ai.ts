/** OpenAI text and image analysis for CASCA's editorial workers. */
export interface EditorialTextOptions {
  systemInstruction?: string;
  userPrompt: string;
  maxOutputTokens?: number;
  temperature?: number;
  model?: string;
  thinkingBudget?: number;
  responseMimeType?: string;
  responseJsonSchema?: Record<string, unknown>;
  timeoutMs?: number;
}
export interface EditorialImageOptions extends Omit<EditorialTextOptions,'userPrompt'> {
  prompt: string;
  imageBase64: string;
  mimeType: string;
}
export class EditorialAIBillingError extends Error {
  constructor() {
    super('OpenAI API billing or quota is unavailable; check the API project billing before retrying');
    this.name='EditorialAIBillingError';
  }
}
/** Convert existing editorial schemas to strict JSON Schema without mutating them. */
export function normalizeEditorialSchema(schema: Record<string,unknown>): Record<string,unknown> {
  const nullable=(value:Record<string,unknown>):void => {
    if (Array.isArray(value.type)) value.type=Array.from(new Set([...value.type,'null']));
    else if (typeof value.type==='string') value.type=[value.type,'null'];
    else if (Array.isArray(value.anyOf)) value.anyOf=[...value.anyOf,{type:'null'}];
    else if (value.$ref) {
      const reference=value.$ref;delete value.$ref;
      value.anyOf=[{$ref:reference},{type:'null'}];
    } else value.type=['string','null'];
    if (Array.isArray(value.enum) && !value.enum.includes(null)) value.enum.push(null);
  };
  const convert=(raw:unknown):unknown => {
    if (Array.isArray(raw)) return raw.map(convert);
    if (!raw || typeof raw!=='object') return raw;
    const input=raw as Record<string,unknown>;
    const output: Record<string,unknown>={};
    for (const [key,value] of Object.entries(input)) {
      if (['nullable','propertyOrdering'].includes(key)) continue;
      output[key]=key==='type' ? (typeof value==='string' ? value.toLowerCase() : Array.isArray(value) ? value.map((type)=>String(type).toLowerCase()) : value) : convert(value);
    }
    if (output.type==='object' || output.properties) {
      const properties=(output.properties ?? {}) as Record<string,Record<string,unknown>>;
      const required=Array.isArray(input.required) ? input.required as string[] : [];
      for (const [name,property] of Object.entries(properties)) {
        if (!required.includes(name)) nullable(property);
      }
      output.additionalProperties=false;
      output.required=Object.keys(properties);
    }
    if (input.nullable===true) {
      nullable(output);
    }
    return output;
  };
  return convert(schema) as Record<string,unknown>;
}
export class EditorialAIClient {
  constructor(private readonly apiKey: string=process.env.OPENAI_API_KEY ?? '', private readonly defaultModel?: string) {}
  async generateText(options:EditorialTextOptions):Promise<string> {
    return this.request(options,[{type:'input_text',text:options.userPrompt}],false);
  }
  async generateTextFromImage(options:EditorialImageOptions):Promise<string> {
    if (!/^image\/(?:jpeg|png|webp|gif)$/.test(options.mimeType)) throw new Error('Unsupported editorial image MIME type');
    return this.request(options,[{type:'input_text',text:options.prompt},{type:'input_image',image_url:`data:${options.mimeType};base64,${options.imageBase64}`,detail:'high'}],true);
  }
  private async request(options:Omit<EditorialTextOptions,'userPrompt'>,content:unknown[],vision:boolean):Promise<string> {
    if (!this.apiKey.trim()) throw new Error('OPENAI_API_KEY is required for editorial text and image validation');
    const requested=options.model || this.defaultModel;
    const model=requested && !requested.startsWith('gemini-') ? requested : (vision ? process.env.OPENAI_VISION_MODEL : process.env.OPENAI_TEXT_MODEL) || 'gpt-5.4-mini';
    const body:Record<string,unknown>={model,store:false,input:[{role:'user',content}],instructions:options.systemInstruction,max_output_tokens:options.maxOutputTokens ?? 4096};
    if (/^gpt-5\.4(?:-mini)?(?:-|$)/.test(model)) {
      body.reasoning={effort:'none'};
      body.temperature=options.temperature ?? 0.7;
    } else if (/^gpt-(?:4\.1|4o)/.test(model)) body.temperature=options.temperature ?? 0.7;
    if (options.responseJsonSchema) body.text={format:{type:'json_schema',name:'casca_editorial_result',strict:true,schema:normalizeEditorialSchema(options.responseJsonSchema)}};
    else if (options.responseMimeType==='application/json') body.text={format:{type:'json_object'}};
    const response=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.apiKey}`},
      signal:AbortSignal.timeout(Math.max(1,Math.min(options.timeoutMs ?? 90000,180000))),body:JSON.stringify(body),
    });
    if (response.status===402) throw new EditorialAIBillingError();
    type EditorialResponse={status?:string;error?:{message?:string;code?:string;type?:string};incomplete_details?:{reason?:string};output?:Array<{type?:string;content?:Array<{type?:string;text?:string;refusal?:string}>}>};
    let payload:EditorialResponse;
    try {payload=await response.json() as EditorialResponse;}
    catch {throw new Error(`OpenAI returned an invalid response (${response.status}); editorial work held`);}
    if (!response.ok) {
      if (response.status===402 || payload.error?.code==='insufficient_quota' || payload.error?.type==='insufficient_quota') throw new EditorialAIBillingError();
      const message=(payload.error?.message || 'Provider request failed').split(this.apiKey).join('[redacted]').replace(/sk-[\w-]+/g,'[redacted]').slice(0,600);
      throw new Error(`OpenAI request failed (${response.status}): ${message}`);
    }
    if (payload.status==='incomplete') throw new Error(`OpenAI editorial response incomplete: ${payload.incomplete_details?.reason || 'unknown reason'}`);
    const parts=payload.output?.flatMap((item)=>item.content ?? []) ?? [];
    if (parts.some((part)=>part.type==='refusal')) throw new Error('OpenAI refused the editorial request; draft held for review');
    const text=parts.filter((part)=>part.type==='output_text').map((part)=>part.text || '').join('').trim();
    if (!text) throw new Error('OpenAI returned no complete editorial text');
    return text;
  }
}
