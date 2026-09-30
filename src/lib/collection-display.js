function collectionDisplayText(value) {
  return String(value ?? '')
    .replace(/!\[[^\]\n]*\]\(https?:\/\/(?:[a-z0-9-]+\.)*dataforseo\.com(?:[/:][^\s)]*)?\)/gi, '[Image omitted]')
    .replace(/https?:\/\/(?:[a-z0-9-]+\.)*dataforseo\.com(?=[/:\s)"<>]|$)[^\s)"<>]*/gi, '[Collection asset omitted]')
    .replace(/\b(?:[a-z0-9-]+\.)*dataforseo\.com\b/gi, '[Collection service]')
    .replace(/\bDataForSEO\b/gi, 'collection provider');
}
function collectionAsset(value) {
  try {const host=new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase(); return host==='dataforseo.com'||host.endsWith('.dataforseo.com');} catch {return false;}
}
export {collectionDisplayText,collectionAsset};
