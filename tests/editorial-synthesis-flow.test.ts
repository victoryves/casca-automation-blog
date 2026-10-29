import {afterEach,describe,expect,it,vi} from 'vitest';
const db=vi.hoisted(()=>({artistOps:{findById:vi.fn(),mergeMetadata:vi.fn()},sourceOps:{findByArtistId:vi.fn()},draftOps:{create:vi.fn(),findById:vi.fn()}}));
vi.mock('../src/db/operations/index.js',()=>db);
vi.mock('../src/config/index.js',()=>({getConfig:()=>({env:{exaApiKey:'fixture',openaiApiKey:'fixture'}})}));
vi.mock('../src/modules/discovery/exa-client.js',()=>({ExaClient:class{}}));
import {SynthesisModule} from '../src/modules/synthesis/index.js';
import {ArticleHumanizer} from '../src/modules/synthesis/humanizer.js';
afterEach(()=>vi.restoreAllMocks());
function setup(){
 vi.clearAllMocks();
 db.artistOps.findById.mockResolvedValue({id:7,full_name:'Maria Silva',status:'verified'});
 db.sourceOps.findByArtistId.mockResolvedValue([{institution:'Museum',url:'https://museum.example/maria',content_summary:'Documented woodcut work in Recife.',credibility_score:90}]);
 db.draftOps.create.mockResolvedValue(19);db.draftOps.findById.mockResolvedValue({id:19});
 const synthesis=new SynthesisModule('fixture');
 const internals=synthesis as unknown as {generateArticle:()=>Promise<unknown>;filterSourcesForArtist:()=>unknown[];filterEditorialSources:()=>unknown[];extractRelevantSourceExcerpt:()=>string};
 vi.spyOn(internals,'filterSourcesForArtist').mockImplementation((_artist:unknown,sources:unknown[])=>sources);
 vi.spyOn(internals,'filterEditorialSources').mockImplementation((sources:unknown[])=>sources);
 vi.spyOn(internals,'extractRelevantSourceExcerpt').mockReturnValue('Documented woodcut work in Recife.');
 vi.spyOn(internals,'generateArticle').mockResolvedValue({title:'Maria Silva: Woodcut Marks in Recife',subtitle:'Context',content:'Original or fallback copy',keywords:[]});
 return synthesis;
}
describe('all synthesized copy passes editorial review before draft persistence',()=>{
 it('persists only the accepted rewrite and review metadata',async()=>{
  const synthesis=setup();const review=vi.spyOn(ArticleHumanizer.prototype,'humanizeArticle').mockResolvedValue({content:'Reviewed copy',changed:true,provider:'openai-editorial-humanizer',review:{lintEngine:'vale',warnings:[],fidelity:'reviewed'}});
  await synthesis.synthesize(7);
  expect(review).toHaveBeenCalledWith('Maria Silva','Original or fallback copy',expect.stringContaining('Documented woodcut'));
  expect(db.draftOps.create.mock.calls[0][0].content).toBe('Reviewed copy');expect(db.artistOps.mergeMetadata.mock.calls[0][0]).toBe(7);
 });
 it('holds the draft when the reviewer rejects a factual change',async()=>{
  const synthesis=setup();vi.spyOn(ArticleHumanizer.prototype,'humanizeArticle').mockRejectedValue(new Error('humanizer:validation-failed:fidelity-review'));
  await expect(synthesis.synthesize(7)).rejects.toThrow('fidelity-review');expect(db.draftOps.create).not.toHaveBeenCalled();expect(db.artistOps.mergeMetadata).not.toHaveBeenCalled();
 });
 it('does not store fallback copy when the reviewer is unavailable',async()=>{
  const synthesis=setup();vi.spyOn(ArticleHumanizer.prototype,'humanizeArticle').mockRejectedValue(new Error('provider unavailable'));
  await expect(synthesis.synthesize(7)).rejects.toThrow('provider unavailable');expect(db.draftOps.create).not.toHaveBeenCalled();
 });
});
