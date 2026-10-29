import { describe,it,expect,vi } from 'vitest';
import { existsSync } from 'node:fs';
const lintEngine=existsSync('vendor/vale/vale')?'vale':'builtin';
import { editorialFindings,assertEditorialCopy,rewritePreservationIssues } from '../src/utils/editorial-style.js';
import { lintEditorialCopy } from '../src/modules/synthesis/editorial-lint.js';
import { ArticleHumanizer } from '../src/modules/synthesis/humanizer.js';
// Long fixture keeps validation realistic without provider calls or touching the live queue.
const paragraph='Maria Silva works with woodcut printing in Recife. Her prints use a limited set of carved forms, leaving the unprinted paper visible around each figure. The dossier describes the marks made by the cutting tool and identifies the materials used in the documented series. These observations concern the visible work rather than a claim about its influence. The account keeps the place, process and attribution explicit, connecting each observation to the evidence available. A change in the scale of a figure alters its relation to the surrounding paper. This reading remains an interpretation of the documented surface, without assigning intentions that the artist has not expressed. The article follows the documented series through its printed forms and materials.';
const original=Array.from({length:4},(_,i)=>paragraph.replace('A change',`In section ${i+1}, a change`)).join('\n\n');
const rewrite=original.replaceAll('works with woodcut printing','makes woodcut prints');
describe('CASCA editorial house style',()=>{
 it('blocks scraped UI and chatbot wrappers before approval',()=>{expect(()=>assertEditorialCopy('Skip to Main Content. Here is your revised article.')).toThrow('editorial-copy');});
 it('keeps grounded prose and uncertainty; treats clichés as advisory',()=>{
   expect(editorialFindings('The catalogue suggests that the work may date from 1972.')).toEqual([]);
   expect(editorialFindings('Her practice leaves an indelible mark.')[0].severity).toBe('warning');
   expect(editorialFindings('The print is titled “A Rich Tapestry”.')).toEqual([]);
 });
 it('blocks duplicate paragraphs and more than four paragraphs',()=>{expect(()=>assertEditorialCopy('First.\n\nFirst.')).toThrow('RepeatedParagraph');expect(()=>assertEditorialCopy('A.\n\nB.\n\nC.\n\nD.\n\nE.')).toThrow('ParagraphLimit');});
 it('locks dates, names, quotations and work titles',()=>{
   const source='Maria Silva made “Blue House” in 1972.';
   expect(rewritePreservationIssues(source,'Maria Silva made “Blue House” in 1973.','Maria Silva')).toContain('numbers-or-dates-changed');
   expect(rewritePreservationIssues(source,'Another Artist made “Blue House” in 1972.','Maria Silva')).toContain('artist-name-changed');
   expect(rewritePreservationIssues(source,'Maria Silva made “Red House” in 1972.','Maria Silva')).toContain('quotation-or-title-changed');
 });
 it('uses the installed Vale rules alongside mandatory local checks',async()=>{
   const result=await lintEditorialCopy('Log in to this rich tapestry.');
   expect(result.engine).toBe(lintEngine);expect(result.findings.map(f=>f.rule)).toContain('ScrapingJunk');expect(result.findings.map(f=>f.rule)).toContain('GenericPraise');
 });
});
describe('editorial rewrite and independent fidelity review',()=>{
 it('audits the rewrite against original and dossier before accepting it',async()=>{
   const generateText=vi.fn().mockResolvedValueOnce(rewrite).mockResolvedValueOnce(JSON.stringify({passed:true,issues:[]}));
   const result=await new ArticleHumanizer({generateText}).humanizeArticle('Maria Silva',original,'Documented dossier');
   expect(result.changed).toBe(true);expect(result.review.fidelity).toBe('reviewed');expect(result.review.lintEngine).toBe(lintEngine);
   const audit=JSON.parse(generateText.mock.calls[1][0].userPrompt);expect(audit.original).toBe(original);expect(audit.proposed).toBe(rewrite);expect(audit.researchContext).toBe('Documented dossier');
 });
 it('rejects changed certainty even when length and paragraphs pass',async()=>{
   const generateText=vi.fn().mockResolvedValueOnce(rewrite).mockResolvedValueOnce(JSON.stringify({passed:false,issues:['A rumor became an established fact']})).mockResolvedValueOnce(rewrite).mockResolvedValueOnce(JSON.stringify({passed:false,issues:['A rumor became an established fact']}));
   await expect(new ArticleHumanizer({generateText}).humanizeArticle('Maria Silva',original)).rejects.toThrow('fidelity-review');expect(generateText).toHaveBeenCalledTimes(4);
 });
 it('never accepts malformed audit output and keeps retries bounded',async()=>{
   const generateText=vi.fn().mockResolvedValueOnce(rewrite).mockResolvedValueOnce('not JSON').mockResolvedValueOnce(rewrite).mockResolvedValueOnce('{"passed":"true","issues":[]}');
   await expect(new ArticleHumanizer({generateText}).humanizeArticle('Maria Silva',original)).rejects.toThrow('fidelity-review');
 });
 it('rejects changed numbers before spending a semantic review call',async()=>{
   const generateText=vi.fn().mockResolvedValue(rewrite.replace('section 1','section 9'));
   await expect(new ArticleHumanizer({generateText}).humanizeArticle('Maria Silva',original)).rejects.toThrow('numbers-or-dates-changed');expect(generateText).toHaveBeenCalledTimes(2);
 });
 it('leaves valid unchanged copy alone without an unnecessary comparison',async()=>{
   const generateText=vi.fn().mockResolvedValue(original);const result=await new ArticleHumanizer({generateText}).humanizeArticle('Maria Silva',original);
   expect(result.changed).toBe(false);expect(result.review.fidelity).toBe('unchanged');expect(generateText).toHaveBeenCalledTimes(1);
 });
});
