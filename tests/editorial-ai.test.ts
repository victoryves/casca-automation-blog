import {afterEach,describe,expect,it,vi} from 'vitest';
import {EditorialAIClient,EditorialAIBillingError,normalizeEditorialSchema} from '../src/lib/editorial-ai.js';
const completed=(text='{"ok":true}')=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]}));
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('OpenAI editorial adapter',()=>{
  it('uses strict schema, configured text model and stateless Responses requests',async()=>{
    const fetcher=vi.fn().mockResolvedValue(completed());vi.stubGlobal('fetch',fetcher);vi.stubEnv('OPENAI_TEXT_MODEL','gpt-5.4-mini');
    expect(await new EditorialAIClient('test-secret').generateText({userPrompt:'Check facts',responseJsonSchema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']}})).toBe('{"ok":true}');
    expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    const body=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body).toMatchObject({model:'gpt-5.4-mini',store:false,reasoning:{effort:'none'},text:{format:{type:'json_schema',strict:true,schema:{additionalProperties:false}}}});
  });
  it('sends actual image pixels at high detail using the vision model',async()=>{
    const fetcher=vi.fn().mockResolvedValue(completed('Artwork'));vi.stubGlobal('fetch',fetcher);vi.stubEnv('OPENAI_VISION_MODEL','gpt-4.1-mini');
    await new EditorialAIClient('test-secret').generateTextFromImage({prompt:'Inspect artwork',imageBase64:'aW1hZ2U=',mimeType:'image/jpeg',model:'gemini-2.5-flash'});
    const body=JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4.1-mini');expect(body.input[0].content[1]).toEqual({type:'input_image',image_url:'data:image/jpeg;base64,aW1hZ2U=',detail:'high'});
  });
  it('normalizes nested optional and nullable schema unions without altering input',()=>{
    const schema={type:'OBJECT',properties:{score:{type:['NUMBER','STRING'],nullable:true},items:{type:'ARRAY',items:{type:'OBJECT',properties:{title:{type:'STRING'}}}}},required:['score']};
    const before=JSON.stringify(schema);const normalized=normalizeEditorialSchema(schema) as any;
    expect(normalized.required).toEqual(['score','items']);expect(normalized.properties.score.type).toEqual(['number','string','null']);expect(normalized.properties.items.type).toEqual(['array','null']);expect(normalized.properties.items.items.additionalProperties).toBe(false);expect(JSON.stringify(schema)).toBe(before);
  });
  it('distinguishes missing API credit from temporary rate limits',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response('private error body',{status:402})).mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'insufficient_quota'}}),{status:429})).mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'rate_limit_exceeded',message:'Rate limited'}}),{status:429}));
    vi.stubGlobal('fetch',fetcher);const client=new EditorialAIClient('test-secret');
    await expect(client.generateText({userPrompt:'Check'})).rejects.toBeInstanceOf(EditorialAIBillingError);
    await expect(client.generateText({userPrompt:'Check'})).rejects.toBeInstanceOf(EditorialAIBillingError);
    await expect(client.generateText({userPrompt:'Check'})).rejects.toThrow('OpenAI request failed (429)');
  });
  it('holds incomplete or refused responses and sanitizes malformed errors',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}))).mockResolvedValueOnce(new Response(JSON.stringify({status:'completed',output:[{content:[{type:'refusal',refusal:'Refused'}]}]}))).mockResolvedValueOnce(new Response('secret body',{status:502}));
    vi.stubGlobal('fetch',fetcher);const client=new EditorialAIClient('test-secret');
    await expect(client.generateText({userPrompt:'Check'})).rejects.toThrow('incomplete');
    await expect(client.generateText({userPrompt:'Check'})).rejects.toThrow('refused');
    await expect(client.generateText({userPrompt:'Check'})).rejects.toThrow('invalid response (502)');
  });
  it('rejects missing credentials and unsupported image MIME before requests',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await expect(new EditorialAIClient('').generateText({userPrompt:'Check'})).rejects.toThrow('OPENAI_API_KEY');
    await expect(new EditorialAIClient('test-secret').generateTextFromImage({prompt:'Check',imageBase64:'data',mimeType:'image/svg+xml'})).rejects.toThrow('MIME');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
