const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const reportNavigationCss=`
.report-contents{margin:20px 0;padding:16px 20px;border:1px solid #cad8d4;border-radius:6px;background:#f0f5f2;break-inside:avoid;scroll-margin-top:20px}
.report-contents h2{font:700 14px/1.4 system-ui,sans-serif;margin:0 0 10px;letter-spacing:.04em}
.report-contents ol{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 24px;list-style:none;padding:0;margin:0;counter-reset:report-contents}
.report-contents li{counter-increment:report-contents;margin:0;font:13px/1.4 system-ui,sans-serif}
.report-contents li::before{content:counter(report-contents,decimal-leading-zero) ' ';color:#526a6f;font-size:11px}
.report-contents a{color:#087e83;text-decoration:underline;text-underline-offset:3px}
.report-back-top{position:fixed;right:24px;bottom:24px;z-index:20;width:48px;height:48px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#12333b;color:white!important;text-decoration:none;font:26px/1 system-ui,sans-serif;box-shadow:0 3px 12px #12333b33;border:2px solid white}
.report-back-top:focus-visible,.report-contents a:focus-visible{outline:3px solid #e39b2b;outline-offset:3px}
[id^="report-section-"],#selected-actions,#collection-review{scroll-margin-top:20px}
@media screen and (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
@media screen{body{padding-bottom:76px}}
@media(max-width:600px){.report-contents{padding:14px}.report-contents ol{grid-template-columns:1fr 1fr;gap:10px 14px}.report-back-top{right:14px;bottom:14px}}
@media print{.report-back-top{display:none!important}.report-contents{padding:9px 12px;margin:12px 0;background:white;border-radius:0}.report-contents h2{font-size:10pt;margin:0 0 6px}.report-contents ol{gap:4px 16px}.report-contents li{font-size:8.5pt}.report-contents li::before{font-size:8pt}body{padding-bottom:0}}
`;
export function reportContents(items){
 return `<nav class="report-contents" id="report-contents" aria-label="Report contents" tabindex="-1"><h2>In this report</h2><ol>${items.map(([id,label])=>`<li><a href="#${esc(id)}">${esc(label)}</a></li>`).join('')}</ol></nav>`;
}
export const reportBackToContents='<a class="report-back-top" href="#report-contents" aria-label="Back to report contents" title="Back to contents"><span aria-hidden="true">↑</span></a>';
