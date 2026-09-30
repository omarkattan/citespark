import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionDisplayText,collectionAsset} from '../src/lib/collection-display.js';
import {measurementHtml} from '../src/lib/measurement-archive.js';
test('collection images are omitted without rewriting answer facts or publisher links',()=>{
 const text='M3.agency\n![](https://api.dataforseo.com/cdn/i/123:18)\nBlue Beetle 4.6 (27)\n[Source](https://example.com/page)';
 const clean=collectionDisplayText(text);
 assert.doesNotMatch(clean,/dataforseo/i);assert.match(clean,/Blue Beetle 4.6 \(27\)/);assert.match(clean,/https:\/\/example.com\/page/);
 assert.match(clean,/Image omitted/);assert.match(text,/dataforseo/);
 assert.equal(collectionAsset('api.dataforseo.com'),true);assert.equal(collectionAsset('https://dataforseo.com.example.org/page'),false);
});
test('archive removes collection sources and branding while keeping original records intact',()=>{
 const row={id:1,ok:true,response_text:'Agency answer ![](https://api.dataforseo.com/cdn/i/x)',citations:[{url:'https://api.dataforseo.com/cdn/i/x'},{url:'https://agency.test/page'}]};
 const before=JSON.stringify(row);
 const html=measurementHtml({id:26,name:'Sandstorm'},{id:26,settings:{},status:'completed'},[row]);
 assert.doesNotMatch(html,/dataforseo/i);assert.match(html,/agency.test\/page/);assert.equal(JSON.stringify(row),before);
});
